/**
 * When saving a recording, fetch each baseline from temp image storage and embed
 * a compressed JPEG data URL on the meta row so replays/reports work after /s blobs expire.
 */

var Promise = require('bluebird')
var gm = require('gm')

var visualCompare = require('./automation-visual-compare')

function gmToJpegDataUrlMaxWidth(buf, maxW, quality) {
  maxW = maxW || 480
  quality = quality != null ? quality : 82
  return new Promise(function(resolve, reject) {
    gm(buf)
      .resize(maxW, maxW, '>')
      .quality(quality)
      .toBuffer('JPEG', function(err, out) {
        if (err) {
          reject(err)
          return
        }
        if (!out || !out.length) {
          reject(new Error('empty jpeg'))
          return
        }
        resolve('data:image/jpeg;base64,' + out.toString('base64'))
      })
  })
}

/**
 * @param {Array} metaList baselinesMeta from client
 * @returns {Promise<Array>}
 */
function hydrateBaselinesMeta(metaList) {
  var list = Array.isArray(metaList) ? metaList : []
  return Promise.map(list, function(meta) {
    if (!meta || !meta.href || meta.inlineDataUrl) {
      return meta
    }
    var abs = visualCompare.resolveBaselineAbsoluteUrl(meta.href)
    if (!abs) {
      return meta
    }
    return visualCompare.fetchUrlToBuffer(abs)
      .then(function(imageBuf) {
        return gmToJpegDataUrlMaxWidth(imageBuf, 480, 82)
          .catch(function() {
            var raw = visualCompare.bufferToDataUrl(imageBuf)
            if (raw) {
              return raw
            }
            throw new Error('gm and raw dataUrl failed')
          })
      })
      .then(function(dataUrl) {
        var copy = {}
        var k
        for (k in meta) {
          if (Object.prototype.hasOwnProperty.call(meta, k)) {
            copy[k] = meta[k]
          }
        }
        copy.inlineDataUrl = dataUrl
        return copy
      })
      .catch(function() {
        return meta
      })
  })
}

module.exports = {
  hydrateBaselinesMeta: hydrateBaselinesMeta
}
