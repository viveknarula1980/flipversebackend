const nacl = require('tweetnacl');
const bs58 = require('bs58');

const kp = nacl.sign.keyPair(); // random (secret64 includes pub)
const secret64 = Buffer.from(kp.secretKey);     // 64 bytes (32 secret || 32 public)
const pub32    = Buffer.from(kp.publicKey);     // 32 bytes

console.log('ADMIN_PRIVKEY_BASE58=' + bs58.encode(secret64));
console.log('ADMIN_PUBKEY_BASE58='  + bs58.encode(pub32));
