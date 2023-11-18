import { OpenID4VCIClient} from '@sphereon/oid4vci-client';
import { AuthzFlowType, Alg } from '@sphereon/oid4vci-common'
import { CredentialRequestClientBuilder } from '@sphereon/oid4vci-client';
import { ProofOfPossession } from '@sphereon/oid4vci-common';
import { agent } from './client_agent.js'
import fetch from 'node-fetch';
import { mapIdentifierKeysToDoc, decodeBase64url, encodeBase64url } from '@veramo/utils'
import { IDIDCommMessage } from '@veramo/did-comm';
import express, {Express, Request, Response} from 'express'
import bodyParser from 'body-parser'
import { IAuthorizationRequestPayloads } from '@sphereon/ssi-sdk.siopv2-oid4vp-rp-auth'

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

await agent.didManagerAddService({did: identifier.did, service: { id: "123", type: "DIDCommMessaging", serviceEndpoint: "http://localhost:8081/didcomm"}})

/* Get keyID for "assertionMethod" (Key ID from Veramo-DB and DID-Document are different) */
const local_key_id = (await mapIdentifierKeysToDoc(identifier, "assertionMethod", {agent:agent}))[0].kid
const global_key_id = (await mapIdentifierKeysToDoc(identifier, "assertionMethod", {agent:agent}))[0].meta.verificationMethod.id



/**********/
/* SERVER */
/**********/
const server: Express = express()

/* Hier kommt die kommt die DidComm Verbindungsanfrage an */
server.post("/didcomm", bodyParser.raw({type: "text/plain"}), async (req: Request, res: Response) => {
  const message = await agent.handleMessage({raw: req.body.toString()})
  const document = (await agent.resolveDid({ didUrl: message.from! })).didDocument!

  if (message.type == "connection_test"){
    const body = message.data! as {nonce:string}
    console.log("DidComm Verbindungsanfrage erhalten: ", body, "\n")

    const response: IDIDCommMessage = {
      type: "connection_ack",
      to: message.from!,
      from: identifier.did,
      id: message.id,
      body: body
    }
    
    console.log("Sende Bestätigung....")
    const packed_msg = await agent.packDIDCommMessage({ message: response, packing: "authcrypt"})
    agent.sendDIDCommMessage({ messageId: "123", packedMessage: packed_msg, recipientDidUrl: message.from! })
    res.sendStatus(200)
  }
  else if (message.type == "offer"){
    const body = message.data! as { nonce:string, offer_uri:string }
    console.log("DidComm Offer erhalten: ", body, "\n")
    preauth_flow(body.offer_uri)
    res.sendStatus(200)
  }
  else {
    res.sendStatus(404)
  }
})
server.listen(8081, () => {
  console.log("Server listening on port 8081\n\n")
})



/***************/
/* CLIENT FLOW */
/***************/

// Scanne QR-Code
const response = new URL(await (await fetch("http://localhost:8080/offer")).text())
console.log("Scanne QR-Code....")

// Wenn SIOP-Anfrage, dann erst SIOP-Flow. Wenn Preauth-Code, dann gleich OID4VC-Flow
if (response.protocol == "openid-vc:"){
  const request_uri = response.searchParams.get("request_uri")!
  await siop_flow(request_uri)
}
else if (response.protocol == "openid-credential-offer:"){
  await preauth_flow(response.toString())
}

/*************/
/* SIOP FLOW */
/*************/
async function siop_flow(req_reference: string){
  console.log("SIOP-Referenz erhalten: ", req_reference, "\n")

  // SIOP-Anfrage holen
  console.log("Folge Referenz....")
  const request = await (await fetch(req_reference)).json() as IAuthorizationRequestPayloads
  console.log("SIOP-Anfrage erhalten: ", request, "\n")

  // ID-Token zurück senden
  console.log("Sende ID-Token....")
  const siop_session = await agent.siopRegisterOPSession({ requestJwtOrUri: request.requestObject! })
  await siop_session.getAuthorizationRequest()
  await siop_session.sendAuthorizationResponse({responseSignerOpts: { identifier: identifier }})
}

/***************/
/* OID4VC FLOW */
/***************/
async function preauth_flow(offer_uri: string){
  // Client erstellen
  console.log("Preauth Code erhalten: ", offer_uri,"\n")
  const client = await OpenID4VCIClient.fromURI({
      uri: offer_uri,
      flowType: AuthzFlowType.PRE_AUTHORIZED_CODE_FLOW,
      alg: Alg.EdDSA,
      retrieveServerMetadata: true,
  })

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

  console.log("issuer: ",client.getIssuer())
  const jwt_payload = encodeBase64url(JSON.stringify({
    aud: client.getIssuer(),
    iat: Math.floor(Date.now() / 1000),
    nonce: token.c_nonce,
    iss: global_key_id
  }))

  const signature = await agent.keyManagerSign({
    keyRef: local_key_id,
    data: jwt_header+"."+jwt_payload,
    algorithm: client.alg
  })

  const proof: ProofOfPossession = {
    proof_type: "jwt",
    jwt: jwt_header +'.'+ jwt_payload +'.'+ signature
  }
  console.log("Proof:\n",proof)

  // Credential Anfrage senden
  console.log("Hole Credential....")
  const credentialRequestClient = CredentialRequestClientBuilder.fromCredentialOfferRequest({request: client.credentialOffer, metadata: client.endpointMetadata}).build()
  const credentialResponse = await credentialRequestClient.acquireCredentialsUsingProof({
    proofInput: proof,
    credentialTypes: ["VerifiableCredential","UniversityDegreeCredential"],
    format: 'jwt_vc_json',
  });

  // Credential
  const credential = JSON.parse(decodeBase64url(credentialResponse.successBody?.credential?.split(".")[1]))
  if (!credentialResponse.errorBody) console.log("Credential erhalten:\n", credential)
  else console.log("Credential Error: ", credentialResponse.errorBody)
}