import { OpenID4VCIClient } from '@sphereon/oid4vci-client';
import { AuthzFlowType, Alg, OpenId4VCIVersion, OpenIDResponse, CredentialResponse } from '@sphereon/oid4vci-common'
import { CredentialRequestClientBuilder } from '@sphereon/oid4vci-client';
import { ProofOfPossession } from '@sphereon/oid4vci-common';
import { agent } from './client_agent.js'
import fetch from 'node-fetch';
import { mapIdentifierKeysToDoc, decodeBase64url, encodeBase64url } from '@veramo/utils'
import { IDIDCommMessage } from '@veramo/did-comm';
import express, { Express, Request, Response } from 'express'
import bodyParser from 'body-parser'

const red = "\x1b[41m"
const green = "\x1b[42m"
const end = "\x1b[0m"

/*********/
/* SETUP */
/*********/
const identifier = await agent.didManagerGetOrCreate({
  alias: "void1042.github.io:web-did-host:client",
  kms: "local",
  provider: "did:web",
  options: {
    keyType: 'Ed25519'
  }
})

await agent.didManagerAddService({ did: identifier.did, service: { id: "123", type: "DIDCommMessaging", serviceEndpoint: "http://localhost:8081/didcomm" } })

/* Get keyID for "assertionMethod" (Key ID from Veramo-DB and DID-Document are different) */
const local_key_id = (await mapIdentifierKeysToDoc(identifier, "assertionMethod", { agent: agent }))[0].kid
const global_key_id = (await mapIdentifierKeysToDoc(identifier, "assertionMethod", { agent: agent }))[0].meta.verificationMethod.id


/**********/
/* SERVER */
/**********/
const server: Express = express()

/* Hier kommt die kommt die DidComm Verbindungsanfrage an */
server.post("/didcomm", bodyParser.raw({ type: "text/plain" }), async (req: Request, res: Response) => {
  const message = await agent.handleMessage({ raw: req.body.toString() })

  if (message.type == "ping") {
    console.log("DidComm Ping erhalten: {id:" + message.id + ", thid:" + message.threadId + ", data:" + JSON.stringify(message.data) + "}")
    const response: IDIDCommMessage = {
      type: "pong",
      to: message.from!,
      from: identifier.did,
      id: Math.random().toString().slice(2, 5),
      thid: message.id,
      body: {}
    }

    console.log("Sende Pong....")
    const packed_msg = await agent.packDIDCommMessage({ message: response, packing: "authcrypt" })
    agent.sendDIDCommMessage({ messageId: "123", packedMessage: packed_msg, recipientDidUrl: message.from! })
    res.sendStatus(200)
  }
  else {
    res.sendStatus(404)
  }
})

const server_instance = server.listen(8081, () => {
  console.log("Server listening on port 8081\n\n")
})


/***************/
/* CLIENT FLOW */
/***************/

// Scanne QR-Code
const response = new URL(await (await fetch("http://localhost:8080/offer")).text())
console.log("Scanne QR-Code....")

const offer_uri = response.toString()

// Client erstellen
console.log("Preauth Code erhalten: ", offer_uri, "\n")
const client = await OpenID4VCIClient.fromURI({
  uri: offer_uri,
  flowType: AuthzFlowType.PRE_AUTHORIZED_CODE_FLOW,
  alg: Alg.EdDSA,
  retrieveServerMetadata: true,
})
console.log("Server Metadata: ", JSON.stringify(client.endpointMetadata, null, 2), "\n")

// Token holen
console.log("Hole Token....")
const token = await client.acquireAccessToken()
console.log("Token erhalten:", token, "\n\n")

// JWT-Proof bauen
const jwt_header = encodeBase64url(JSON.stringify({
  typ: "openid4vci-proof+jwt",
  alg: client.alg,
  kid: global_key_id
}))

console.log("issuer: ", client.getIssuer())
const jwt_payload = encodeBase64url(JSON.stringify({
  aud: client.getIssuer(),
  iat: Math.floor(Date.now() / 1000),
  nonce: token.c_nonce,
  iss: global_key_id
}))

const signature = await agent.keyManagerSign({
  keyRef: local_key_id,
  data: jwt_header + "." + jwt_payload,
  algorithm: client.alg
})

const proof: ProofOfPossession = {
  proof_type: "jwt",
  jwt: jwt_header + '.' + jwt_payload + '.' + signature
}
console.log("Proof:\n", proof)

// Credential Anfrage
console.log("Hole Credential....")
const credentialRequestClient = CredentialRequestClientBuilder.fromCredentialOfferRequest({ request: client.credentialOffer, metadata: client.endpointMetadata }).build()
let credentialRequest = await credentialRequestClient.createCredentialRequest({
  proofInput: proof,
  credentialTypes: ["VerifiableCredential", "UniversityDegreeCredential"],
  format: 'jwt_vc_json',
  version: OpenId4VCIVersion.VER_1_0_11
})
Object.defineProperty(credentialRequest, "didcomm_proof", { value: proof, enumerable: true })

// Antwort entweder Credential oder Deferral
type DeferredResponse = { transaction_id:string, c_nonce:string }
const credentialResponse = await credentialRequestClient.acquireCredentialsUsingRequest(credentialRequest) as OpenIDResponse<CredentialResponse|DeferredResponse>

if (credentialResponse.successBody) {
  if("transaction_id" in credentialResponse.successBody){
    console.log("Deferral erhalten. Versuche alle 1 sek.:")
    const {transaction_id, c_nonce} = credentialResponse.successBody

    // Loop
    const intervalID = setInterval(async () => {
      console.log("> Frage Status ab....")
      const response = await fetch("http://localhost:8080/deferred", {method: "post", body: JSON.stringify({transaction_id:transaction_id, c_nonce:c_nonce}), headers: {'Content-Type': 'application/json'}})

      if (response.ok){
        const data = await response.json() as { credential:string }
        const credential = JSON.parse(decodeBase64url(data.credential.split(".")[1]))
        console.log(green,"< Credential erhalten:",end,"\n",credential)
        clearInterval(intervalID) //Stop Loop
      }
      else{
        const {error} = await response.json() as { error:string }
        
        switch (error) {
          case "issuance_pending":
            console.log("< Credential noch nicht bereit")
            break
          case "didcomm_unreachable":
            console.error(red,"DidComm Verbindung fehlgeschlagen",end)
            clearInterval(intervalID)
            break
          case "invalid_transaction_id":
            console.error(red,"Credential nicht gefunden",end)
            clearInterval(intervalID)
            break
          default:
            console.error(red,"Unbekannter Fehler",end)
            clearInterval(intervalID)
            break
        }
      }
    }, 1000)
  }
  else{
    const credential = JSON.parse(decodeBase64url(credentialResponse.successBody?.credential?.split(".")[1]))
    console.log(green,"Credential erhalten:",end,"\n", credential)
  }
}
else console.log("Credential Error: ", credentialResponse.errorBody)

// close Server
server_instance.close()
