var http = require('http')
var https = require('https')
var url = require('url')

var Promise = require('bluebird')
var gm = require('gm')

var similarity = require('./automation-visual-similarity')

var DEFAULT_IMAGE_PLUGIN_ORIGIN = 'http://127.0.0.1:7103'
var DEFAULT_STORAGE_TEMP_ORIGIN = 'http://127.0.0.1:7102'

function imagePluginBaseOrigin() {
  var u = process.env.STF_STORAGE_PLUGIN_IMAGE_URL ||
    process.env.STF_AUTOMATION_IMAGE_BASE_URL ||
    ''
  u = String(u || '').trim()
  if (!u) {
    return DEFAULT_IMAGE_PLUGIN_ORIGIN
  }
  if (u[u.length - 1] === '/') {
    return u.slice(0, -1)
  }
  return u
}

/**
 * Raw files live on the temp storage unit (/s/blob/...). The image plugin (/s/image/...) may return
 * HTTP 500 if GraphicsMagick transform fails — fall back to blob on the storage port.
 */
function storageTempBaseOrigin() {
  var u = process.env.STF_STORAGE_URL ||
    process.env.STF_AUTOMATION_STORAGE_URL ||
    ''
  u = String(u || '').trim()
  if (!u) {
    return DEFAULT_STORAGE_TEMP_ORIGIN
  }
  if (u[u.length - 1] === '/') {
    return u.slice(0, -1)
  }
  return u
}

function storageBlobUrlFromImagePath(absUrl) {
  try {
    var p = url.parse(absUrl)
    var path = normalizeStorageImagePathname(p.pathname || '')
    if (path.indexOf('/s/image/') !== 0) {
      return null
    }
    var rest = path.slice('/s/image/'.length)
    if (!rest) {
      return null
    }
    return storageTempBaseOrigin() + '/s/blob/' + rest
  }
  catch (e) {
    return null
  }
}

/**
 * Reverse proxies often expose image URLs as /x/image/ while the image plugin listens on /s/image/.
 * Server-side fetch must use the path the storage unit actually serves.
 */
function normalizeStorageImagePathname(pathname) {
  var p = String(pathname || '').trim()
  if (p.indexOf('/x/image/') === 0) {
    return '/s/image/' + p.slice('/x/image/'.length)
  }
  if (p.indexOf('/x/blob/') === 0) {
    return '/s/blob/' + p.slice('/x/blob/'.length)
  }
  return p
}

function resolveBaselineAbsoluteUrl(href) {
  var h = String(href || '').trim()
  if (!h) {
    return null
  }
  if (/^https?:\/\//i.test(h)) {
    try {
      var parsed = url.parse(h)
      var np = normalizeStorageImagePathname(parsed.pathname || '')
      if (np !== (parsed.pathname || '')) {
        parsed.pathname = np
        return url.format(parsed)
      }
    }
    catch (e) {
      /* fall through */
    }
    return h
  }
  if (h[0] !== '/') {
    h = '/' + h
  }
  h = normalizeStorageImagePathname(h)
  if (h[0] !== '/') {
    h = '/' + h
  }
  return imagePluginBaseOrigin() + h
}

function fetchUrlToBufferOnce(absUrl) {
  return new Promise(function(resolve, reject) {
    var parsed = url.parse(absUrl)
    var lib = parsed.protocol === 'https:' ? https : http
    var req = lib.get(absUrl, function(res) {
      if (res.statusCode !== 200) {
        reject(new Error('HTTP ' + res.statusCode + ' 拉取基线图失败'))
        return
      }
      var chunks = []
      res.on('data', function(c) {
        chunks.push(c)
      })
      res.on('end', function() {
        resolve(Buffer.concat(chunks))
      })
    })
    req.on('error', reject)
    req.setTimeout(20000, function() {
      req.destroy()
      reject(new Error('拉取基线图超时'))
    })
  })
}

function alternateImagePluginFetchUrl(absUrl) {
  try {
    var p = url.parse(absUrl)
    var path = p.pathname || ''
    if (path.indexOf('/s/image/') === 0) {
      p.pathname = '/x/image/' + path.slice('/s/image/'.length)
      var u = url.format(p)
      return u === absUrl ? null : u
    }
    if (path.indexOf('/x/image/') === 0) {
      p.pathname = '/s/image/' + path.slice('/x/image/'.length)
      var u2 = url.format(p)
      return u2 === absUrl ? null : u2
    }
  }
  catch (e) {
    return null
  }
  return null
}

function collectBaselineFetchCandidates(absUrl) {
  var out = []
  function add(u) {
    if (u && out.indexOf(u) === -1) {
      out.push(u)
    }
  }
  add(absUrl)
  add(alternateImagePluginFetchUrl(absUrl))
  add(storageBlobUrlFromImagePath(absUrl))
  var swapped = alternateImagePluginFetchUrl(absUrl)
  if (swapped) {
    add(storageBlobUrlFromImagePath(swapped))
  }
  return out
}

function fetchUrlToBuffer(absUrl) {
  var candidates = collectBaselineFetchCandidates(absUrl)
  if (!candidates.length) {
    return Promise.reject(new Error('无可用基线地址'))
  }
  var lastErr = null
  function attempt(i) {
    if (i >= candidates.length) {
      return Promise.reject(lastErr || new Error('拉取基线失败'))
    }
    return fetchUrlToBufferOnce(candidates[i]).catch(function(err) {
      lastErr = err
      return attempt(i + 1)
    })
  }
  return attempt(0)
}

/**
 * Resize to GRID x GRID RGB raw (GraphicsMagick). Both inputs must decode.
 */
function gmToRgbGrid(imageBuffer, grid) {
  grid = grid || 64
  return new Promise(function(resolve, reject) {
    gm(imageBuffer)
      .resize(grid, grid, '!')
      .toBuffer('RGB', function(err, buf) {
        if (err) {
          reject(err)
          return
        }
        if (!buf || buf.length !== grid * grid * 3) {
          reject(new Error('图像归一化输出尺寸异常'))
          return
        }
        resolve(buf)
      })
  })
}

/**
 * @param {Buffer} baselineBuf
 * @param {Buffer} actualBuf
 * @param {number} threshold 0..1
 * @returns {Promise<{ok: boolean, score: number}>}
 */
function compareImageBuffers(baselineBuf, actualBuf, threshold) {
  var th = Number(threshold)
  if (!isFinite(th)) {
    th = 0.95
  }
  if (th > 1) {
    th = 1
  }
  if (th < 0.05) {
    th = 0.05
  }

  if (baselineBuf && actualBuf && baselineBuf.length === actualBuf.length &&
      typeof baselineBuf.equals === 'function' && baselineBuf.equals(actualBuf)) {
    return Promise.resolve({ok: true, score: 1})
  }

  return Promise.join(
    gmToRgbGrid(baselineBuf)
  , gmToRgbGrid(actualBuf)
  , function(rgbA, rgbB) {
    var score = similarity.rgbByteArraysSimilarity(rgbA, rgbB)
    return {
      ok: score >= th
    , score: score
    }
  })
}

function dataUrlToBuffer(dataUrl) {
  var m = /^data:([^;]*);base64,([\s\S]+)$/i.exec(String(dataUrl || '').trim().replace(/\s/g, ''))
  if (!m) {
    return null
  }
  try {
    return Buffer.from(m[2], 'base64')
  }
  catch (e) {
    return null
  }
}

function bufferToDataUrl(buf) {
  if (!buf || !buf.length) {
    return null
  }
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'data:image/png;base64,' + buf.toString('base64')
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    return 'data:image/jpeg;base64,' + buf.toString('base64')
  }
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return 'data:image/gif;base64,' + buf.toString('base64')
  }
  return 'data:image/png;base64,' + buf.toString('base64')
}

function formatCompareError(err) {
  if (err == null) {
    return '未知错误'
  }
  if (typeof err === 'string') {
    return err
  }
  if (typeof err === 'number' || typeof err === 'boolean') {
    return String(err)
  }
  if (err.message) {
    return String(err.message)
  }
  try {
    return JSON.stringify(err)
  }
  catch (e) {
    return String(err)
  }
}

module.exports = {
  resolveBaselineAbsoluteUrl: resolveBaselineAbsoluteUrl
, fetchUrlToBuffer: fetchUrlToBuffer
, compareImageBuffers: compareImageBuffers
, imagePluginBaseOrigin: imagePluginBaseOrigin
, bufferToDataUrl: bufferToDataUrl
, dataUrlToBuffer: dataUrlToBuffer
, formatCompareError: formatCompareError
}
