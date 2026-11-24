#!/usr/bin/env node
// A fresh RSA-2048 signing key for Silos ID, as a PKCS8 PEM on stdout:
//   node scripts/gen-key.mjs | npx wrangler secret put SILOS_ID_PRIVATE_KEY
// Keep no copy you don't need: the Worker secret is the key. A new key
// invalidates nothing stored (passes live 120 s; instances fetch /jwks).
import { generateKeyPairSync } from 'node:crypto'

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
process.stdout.write(privateKey.export({ format: 'pem', type: 'pkcs8' }).toString())
