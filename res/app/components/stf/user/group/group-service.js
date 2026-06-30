var Promise = require('bluebird')

module.exports = function GroupServiceFactory(
  socket
, TransactionService
, TransactionError
) {
  var groupService = {
  }

  groupService.invite = function(device, usage) {
    if (!device.usable) {
      return Promise.reject(new Error('Device is not usable'))
    }

    var tx = TransactionService.create(device)
    socket.emit('group.invite', device.channel, tx.channel, {
      requirements: {
        serial: {
          value: device.serial
        , match: 'exact'
        }
      }
    , usage: usage || null
    })
    return tx.promise
      .then(function(result) {
        return result.device
      })
      .catch(TransactionError, function() {
        throw new Error('Device refused to join the group')
      })
  }

  groupService.kick = function(device, force, reason) {
    if (!force && !device.usable) {
      return Promise.reject(new Error('Device is not usable'))
    }

    var tx = TransactionService.create(device)
    var payload = {
      requirements: {
        serial: {
          value: device.serial
        , match: 'exact'
        }
      }
    }
    if (reason) {
      payload.reason = reason
    }
    socket.emit('group.kick', device.channel, tx.channel, payload)
    return tx.promise
      .then(function(result) {
        return result.device
      })
      .catch(TransactionError, function() {
        throw new Error('Device refused to join the group')
      })
  }

  return groupService
}
