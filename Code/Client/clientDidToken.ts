import { AccessTokenClient, OpenID4VCIClient } from '@sphereon/oid4vci-client';
import { AuthzFlowType, Alg, OpenId4VCIVersion, OpenIDResponse, CredentialResponse } from '@sphereon/oid4vci-common'
import { CredentialRequestClientBuilder } from '@sphereon/oid4vci-client';
import { ProofOfPossession } from '@sphereon/oid4vci-common';
import { agent } from './clientAgent.js'
import fetch from 'node-fetch';
import { mapIdentifierKeysToDoc, decodeBase64url, encodeBase64url } from '@veramo/utils'
import { IDIDCommMessage } from '@veramo/did-comm';
import express, { Express, Request, Response } from 'express'
import bodyParser from 'body-parser'
import { W3CVerifiableCredential } from '@veramo/core';
import { W3cMessageHandler } from '@veramo/credential-w3c';
import * as readline from "readline"
import prompts from 'prompts'

var verbose = false
const red = "\x1b[41m"
const green = "\x1b[42m"
const yellow = "\x1b[43m"
const end = "\x1b[0m"

/*********/
/* SETUP */
/*********/
const identifier = await agent.didManagerGetOrCreate({
  alias: "raw.githubusercontent.com:IDunion:OpenIDIDComm:main:DID_Documents:Client",
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

console.log(`
+---------------------------------------------------------------------------------------+
| DID: did:web:raw.githubusercontent.com:IDunion:OpenIDIDComm:main:DID_Documents:Client |
| URL: http://localhost:8081                                                            |
+---------------------------------------------------------------------------------------+
`)


/**********/
/* SERVER */
/**********/
const server: Express = express()

/* DidComm Endpoint                                   */ 
/* TODO: Error handling, but easier to read like this */
server.post("/didcomm", bodyParser.raw({ type: "text/plain" }), async (req: Request, res: Response) => {
  res.sendStatus(202)
  process.stdout.write('\n>[DidComm] ')

  const didcomm_message = await agent.handleMessage({ raw: req.body.toString() })
  const {type,data} = didcomm_message
  debug(didcomm_message)

  switch (type) {
    case "https://didcomm.org/oidassociate/1.0/acknowledge_token":
      console.log("Presentation Successful")
      var {oidtoken} = data! as {oidtoken:string}
      outstanding_registrations[oidtoken].acknowledge()
      break
    
    case "https://didcomm.org/oidassociate/1.0/reject_token":
      var {oidtoken,reason} = data! as {oidtoken:string,reason:String}
      console.error(`Presentation failed. Reason: '${reason}'`)
      break

    case "https://didcomm.org/basicmessage/2.0/message": // Arbitrary message
      const {content} = data! as {content:string}
      console.log(content)
      break

    case "opendid4vci-re-offer":
      console.log('Offer Received')
      const {offer} = data! as {offer:string}
      main(offer)
      break

    case "opendid4vci-revocation":
      console.warn('Credential Revoked')
      break

    default:
      console.warn(`Unknown Message Type: '${type}'`)
  }
})

const server_instance = server.listen(8081)


/***************/
/* CLIENT FLOW */
/***************/

var outstanding_registrations: Record<string /*Token*/, { acknowledge: () => void }> = {}
var credential: W3CVerifiableCredential | undefined
var early_resolve: (val: W3CVerifiableCredential) => void
var early_reject: (error: any) => void
var c_nonce: string

async function main(offer_uri?: string) {

  if (!offer_uri) {
    // Scan QR-Code (theoretically)
    console.log("\n< Scan QR Code")
    //const response = new URL(await (await fetch("http://localhost:8080/offer")).text())
    const response = (await prompts({ type: 'text', name: 'value', message: 'Enter Offer:' })).value as string;
    console.log("> Preauth Code")
    debug(response)

    offer_uri = response
  }

  // Create Client 
  console.log("\n< Request Metadata")
  const client = await OpenID4VCIClient.fromURI({
    uri: offer_uri,
    flowType: AuthzFlowType.PRE_AUTHORIZED_CODE_FLOW,
    alg: Alg.EdDSA,
    retrieveServerMetadata: true,
  })
  const didcomm_required = (client.endpointMetadata.credentialIssuerMetadata?.credentials_supported as any[])[0].didcommRequired
  if (didcomm_required == "Required") console.log("> Metadata: DidComm " + red + didcomm_required + end)
  else console.log("> Metadata: DidComm " + green + didcomm_required + end)
  debug(JSON.stringify(client.endpointMetadata, null, 2))

  // Request Token
  console.log("\n< Request Token")

  const accessTokenClient = new AccessTokenClient();
  const response = await accessTokenClient.acquireAccessToken({ credentialOffer: client.credentialOffer, metadata: client.endpointMetadata });
  if (response.errorBody) {
    console.log(red+"> Error: "+response.errorBody.error+end)
    return
  }
  const token = response.successBody! ?? {}
  debug(token)

  console.log("> Token: '"+token.access_token.slice(0,7)+"'. Scope: ["+token.scope+"]")

  // Build Proof of Possession
  const jwt_header = encodeBase64url(JSON.stringify({
    typ: "openid4vci-proof+jwt",
    alg: client.alg,
    kid: global_key_id
  }))

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

  // Present Token over DidComm
  if (didcomm_required == "Required") {
    await new Promise<string>(async (res, rej) => {
      const timeoutID = setTimeout(rej, 4000)

      await send_didcomm_msg(client.endpointMetadata.credentialIssuerMetadata!.did, identifier.did, "https://didcomm.org/oidassociate/1.0/present_token", { oidtoken: token.access_token })
      outstanding_registrations[token.access_token] = { acknowledge: () => { clearTimeout(timeoutID); res("") } }
      process.stdout.write("\n<[DidComm] Present Token: '"+token.access_token.slice(0,7)+"'")
    }).catch(e => { 
      console.error(red + 'DIDComm Connection failed, aborting OID4VCI flow...' + end)
      return
    })
  }


  // Request Credential
  console.log("\n< Request Credential. Access Token: '"+token.access_token.slice(0,7)+"'")
  const credentialRequestClient = CredentialRequestClientBuilder.fromCredentialOfferRequest({ request: client.credentialOffer, metadata: client.endpointMetadata }).withTokenFromResponse(token).build()
  let credentialRequest = await credentialRequestClient.createCredentialRequest({
    proofInput: proof,
    credentialTypes: ["VerifiableCredential", "UniversityDegreeCredential"],
    format: 'jwt_vc_json',
    version: OpenId4VCIVersion.VER_1_0_11
  })
  debug(credentialRequest)

  const credentialResponse = await credentialRequestClient.acquireCredentialsUsingRequest(credentialRequest)

  if (credentialResponse.successBody) {
    credential = JSON.parse(decodeBase64url(credentialResponse.successBody?.credential?.split(".")[1]))
    console.log(green + "> Credential:", end, "\n", credential)

    await start_didcomm_chat(client.endpointMetadata.credentialIssuerMetadata!.did)
  }
  else console.log(red + "> Credential Error: ", end, credentialResponse.errorBody)
}

await main()

// close Server
server_instance.close()

/***********/
/* UTILITY */
/***********/

function debug(message: any) {
  if (verbose == true) console.debug(message)
}

async function send_didcomm_msg(to: string, from: string, type: string, body: Object, thid?: string): Promise<string> {
  const message: IDIDCommMessage = {
    type: type,
    to: to,
    from: from,
    id: Math.random().toString().slice(2, 5),
    ...(thid !== undefined) && { thid: thid },
    body: body
  }

  const packed_msg = await agent.packDIDCommMessage({ message: message, packing: "authcrypt" })
  await agent.sendDIDCommMessage({ messageId: message.id, packedMessage: packed_msg, recipientDidUrl: message.to })

  return message.id
}

async function start_didcomm_chat(to:string) {
  console.log(`
+--------------+
| DidComm Chat |
+--------------+`
  )

  while (true) {
    const text = (await prompts({
        type: 'text',
        name: 'message',
        message: `Enter a message:`
    })).message as string

    if (text.startsWith('/')) {
        // Its a command
        switch (text) {
            case '/quit':
            case '/q':
                return
            case '/help':
              console.log(
                '/help      shows this help dialog\n' +
                '/q /quit   exit to menu\n'
              )
              break
            default:
                console.error('Unknown command')
                break
        }
    }
    else {
        // Normal Message
        send_didcomm_msg(to, identifier.did, 'https://didcomm.org/basicmessage/2.0/message', { content: text })
    }
  }
}