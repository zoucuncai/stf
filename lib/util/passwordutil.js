var crypto = require('crypto')

function hashPassword(password) {
  if (typeof password !== 'string') {
    password = String(password || '')
  }
  var salt = crypto.randomBytes(16).toString('hex')
  var hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex')
  return salt + '$' + hash
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false
  var parts = stored.split('$')
  if (parts.length !== 2) return false
  var salt = parts[0]
  var expectedHash = parts[1]
  var actualHash = crypto.pbkdf2Sync(String(password || ''), salt, 100000, 64, 'sha512').toString('hex')
  return crypto.timingSafeEqual(Buffer.from(actualHash), Buffer.from(expectedHash))
}

module.exports = {
  hashPassword: hashPassword
, verifyPassword: verifyPassword
}

