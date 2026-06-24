/**
 * Self-contained HTML test reports for automation replay / monkey runs.
 */

var Promise = require('bluebird')
var visualCompare = require('./automation-visual-compare')

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function inferReplayStatusFromDevices(devices) {
  var ds = devices || []
  if (!ds.length) {
    return null
  }
  var anyRunning = ds.some(function(d) {
    return d.status === 'running'
  })
  if (anyRunning) {
    return 'running'
  }
  var anyFail = ds.some(function(d) {
    return d.result === '失败' || d.status === 'failed'
  })
  if (anyFail) {
    return 'failed'
  }
  var allTerminal = ds.every(function(d) {
    return d.status === 'finished' || d.status === 'done' || d.status === 'failed'
  })
  return allTerminal ? 'finished' : 'running'
}

function inferLatestDeviceEndedAt(devices) {
  var latest = ''
  ;(devices || []).forEach(function(d) {
    var e = d.endedAt
    if (e && (!latest || String(e) > String(latest))) {
      latest = e
    }
  })
  return latest
}

function replayStatusLabel(status) {
  if (status === 'finished' || status === 'done') {
    return '已完成'
  }
  if (status === 'failed') {
    return '失败'
  }
  if (status === 'running') {
    return '执行中'
  }
  return status || '—'
}

function formatLocalTime(iso) {
  if (!iso) {
    return ''
  }
  try {
    var d = new Date(iso)
    if (isNaN(d.getTime())) {
      return String(iso)
    }
    return d.toISOString().replace('T', ' ').slice(0, 19)
  }
  catch (e) {
    return String(iso)
  }
}

function artifactDetailToString(d) {
  if (d == null || d === '') {
    return ''
  }
  if (typeof d === 'string') {
    return d
  }
  if (typeof d === 'number' || typeof d === 'boolean') {
    return String(d)
  }
  if (d.message) {
    return String(d.message)
  }
  try {
    return JSON.stringify(d)
  }
  catch (e) {
    return String(d)
  }
}

function imgOrPlaceholder(src, alt) {
  if (!src) {
    return '<span class="muted">（无截图）</span>'
  }
  return '<img src="' + escapeHtml(src) + '" alt="' + escapeHtml(alt || '') +
    '" style="max-width:360px;max-height:640px;border:1px solid #ccc"/>'
}

function formatCaseRangeLine(startedStr, endedStr) {
  var a = String(startedStr || '').trim()
  var b = String(endedStr || '').trim()
  if (a && b) {
    return a.replace(/-/g, '/') + ' ~ ' + b.replace(/-/g, '/')
  }
  return a || b || '—'
}

/** SVG path for pie slice: center cx,cy, radius r, angles in radians from east CCW; start at -π/2 for top. */
function svgPieSlice(cx, cy, r, a0, a1) {
  var x0 = cx + r * Math.cos(a0)
  var y0 = cy + r * Math.sin(a0)
  var x1 = cx + r * Math.cos(a1)
  var y1 = cy + r * Math.sin(a1)
  var large = a1 - a0 > Math.PI ? 1 : 0
  return 'M ' + cx + ' ' + cy + ' L ' + x0 + ' ' + y0 + ' A ' + r + ' ' + r + ' 0 ' + large + ' 1 ' + x1 + ' ' + y1 + ' Z'
}

/**
 * @param {object} run
 * @param {Array} devices — automationReplayRunDevices rows
 * @param {object} recording — optional automationRecordings row
 */
function buildReplayTestReportHtml(run, devices, recording) {
  var name = (run && run.recordingName) || (recording && recording.name) || '未命名脚本'
  var started = formatLocalTime(run && (run.startedAt || run.createdAt))
  var rawStatus = run && run.status ? String(run.status) : ''
  if (rawStatus === 'running') {
    var inferredSt = inferReplayStatusFromDevices(devices)
    if (inferredSt && inferredSt !== 'running') {
      rawStatus = inferredSt
    }
  }
  var endedRaw = (run && run.endedAt) || inferLatestDeviceEndedAt(devices)
  var endedDisplay = formatLocalTime(endedRaw)

  var totalPass = 0
  var totalFail = 0
  ;(devices || []).forEach(function(d) {
    var tc = Number(d.totalCases) || 0
    var sc = Number(d.successCases) || 0
    totalPass += sc
    totalFail += Math.max(0, tc - sc)
  })
  var totalCases = totalPass + totalFail
  var invalidCount = 0
  var blockedCount = 0
  ;(devices || []).forEach(function(d) {
    if (d.status === 'running') {
      blockedCount += 1
    }
  })
  var passRateNum = totalCases > 0 ? (totalPass / totalCases) * 100 : 0
  var passRateStr = totalCases > 0 ? passRateNum.toFixed(1) + '%' : '—'

  var cx = 100
  var cy = 100
  var r = 90
  var aStart = -Math.PI / 2
  var piePaths = ''
  if (totalCases <= 0) {
    piePaths = '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="#3f4450"/>'
  }
  else {
    var fracPass = totalPass / totalCases
    var fracFail = totalFail / totalCases
    var aPassEnd = aStart + 2 * Math.PI * fracPass
    var aFailEnd = aStart + 2 * Math.PI
    if (totalPass > 0) {
      piePaths += '<path fill="#34d399" d="' + svgPieSlice(cx, cy, r, aStart, aPassEnd) + '"/>'
    }
    if (totalFail > 0) {
      piePaths += '<path fill="#f87171" d="' + svgPieSlice(cx, cy, r, aPassEnd, aFailEnd) + '"/>'
    }
    if (totalPass === 0 && totalFail === 0) {
      piePaths = '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="#3f4450"/>'
    }
  }

  var targets = (run && Array.isArray(run.targets)) ? run.targets : []
  var targetLine = targets.length
    ? escapeHtml(targets.map(function(t) { return String(t) }).join(', '))
    : '—'
  var executor = escapeHtml((run && (run.createdByEmail || run.createdByName)) || '—')
  var resultsLine = escapeHtml(replayStatusLabel(rawStatus)) +
    (endedDisplay ? ' · ' + escapeHtml(endedDisplay) : '')

  var replayErrorsJson = {}
  var tableRows = ''
  ;(devices || []).forEach(function(d, di) {
    var tc = Number(d.totalCases) || 0
    var sc = Number(d.successCases) || 0
    var fc = Math.max(0, tc - sc)
    var serialRaw = d.serial || ''
    var serialEsc = escapeHtml(serialRaw)
    var errList = []
    if (d.error != null && String(d.error).trim() !== '') {
      errList.push('设备错误: ' + String(d.error).trim())
    }
    var arts = Array.isArray(d.reportArtifacts) ? d.reportArtifacts : []
    arts.forEach(function(a, ai) {
      var t = a.title || ('断言失败 #' + (ai + 1))
      var det = artifactDetailToString(a.detail)
      var parts = [t]
      if (det) {
        parts.push(det)
      }
      errList.push(parts.join(' — '))
    })
    var errKey = 'd' + di
    replayErrorsJson[errKey] = errList

    var invalidCell = 0
    var blockedCell = d.status === 'running' ? 1 : 0
    var failCell = fc > 0
      ? '<button type="button" class="num-fail js-fail-btn" data-err-key="' + escapeHtml(errKey) + '" title="查看失败详情">' +
        String(fc) + '</button>'
      : '<span class="num-zero">0</span>'

    var anchorDomId = 'fail-' + String(serialRaw).replace(/[^a-zA-Z0-9_-]/g, '_')
    var locateLink = fc > 0
      ? ' · <a class="link-action js-open-details" href="#" data-scroll="' + escapeHtml(anchorDomId) + '">定位</a>'
      : ''

    tableRows += '<tr>' +
      '<td class="td-device"><code>' + serialEsc + '</code></td>' +
      '<td>' + String(tc) + '</td>' +
      '<td class="td-pass">' + String(sc) + '</td>' +
      '<td class="td-fail">' + failCell + '</td>' +
      '<td class="td-invalid">' + String(invalidCell) + '</td>' +
      '<td class="td-blocked">' + String(blockedCell) + '</td>' +
      '<td class="td-action">' +
      '<a class="link-action js-open-details" href="#" data-scroll="gallery-top">截图区</a>' +
      locateLink +
      ' · <a class="link-action js-open-details" href="#" data-scroll="exec-log-top">日志</a>' +
      '</td></tr>\n'
  })
  if (!tableRows) {
    tableRows = '<tr><td colspan="7" class="td-empty">暂无设备数据</td></tr>'
  }

  var galleryHtml = ''
  var galleryCount = 0
  var galleryAnchoredSerial = {}
  ;(devices || []).forEach(function(d) {
    var serial = escapeHtml(d.serial || '')
    var serialRaw = String(d.serial || '')
    var anchorId = 'fail-' + serialRaw.replace(/[^a-zA-Z0-9_-]/g, '_')
    var arts = Array.isArray(d.reportArtifacts) ? d.reportArtifacts : []
    arts.forEach(function(a) {
      galleryCount += 1
      var title = escapeHtml(a.title || ('失败 #' + galleryCount))
      var detail = escapeHtml(artifactDetailToString(a.detail))
      var expText = a.expectedText != null ? escapeHtml(String(a.expectedText)) : ''
      var expImg = a.expectedImageDataUrl || ''
      if (!expImg && recording && Array.isArray(recording.baselinesMeta) && a.baselineIndex != null) {
        var bix = Number(a.baselineIndex)
        if (isFinite(bix) && bix >= 0 && recording.baselinesMeta[bix] &&
            recording.baselinesMeta[bix].inlineDataUrl) {
          expImg = recording.baselinesMeta[bix].inlineDataUrl
        }
      }
      if (!expImg) {
        expImg = a.expectedImageHref || ''
      }
      var expIsDataUrl = typeof expImg === 'string' && expImg.indexOf('data:') === 0
      var expHrefNote = ''
      if (!expIsDataUrl && a.expectedImageHref) {
        expHrefNote = '<div class="cap-note">基线链接（若无法显示请重新保存录制以嵌入基线）: <code>' +
          escapeHtml(String(a.expectedImageHref)) + '</code></div>'
      }
      var actImg = a.actualImageDataUrl || a.actualImageHref || ''

      var idAttr = ''
      if (serialRaw && !galleryAnchoredSerial[serialRaw]) {
        galleryAnchoredSerial[serialRaw] = true
        idAttr = ' id="' + escapeHtml(anchorId) + '"'
      }
      galleryHtml += '<div class="fail-item"' + idAttr + '>'
      galleryHtml += '<h3>' + title + ' <span class="device-tag">设备 ' + serial + '</span></h3>'
      galleryHtml += '<div class="screenshot-comparison">'
      galleryHtml += '<div><div class="cap-label">实际截图</div>' + imgOrPlaceholder(actImg, 'actual') + '</div>'
      if (expImg || expHrefNote) {
        galleryHtml += '<div><div class="cap-label">预期 / 基线</div>' +
          imgOrPlaceholder(expImg, 'expected') + expHrefNote + '</div>'
      }
      galleryHtml += '</div>'
      if (expText && !expImg) {
        galleryHtml += '<div class="diff-text">期望包含文本：<code>' + expText + '</code></div>'
      }
      if (detail) {
        galleryHtml += '<div class="diff-text">详情：' + detail + '</div>'
      }
      galleryHtml += '</div>'
    })
  })

  var logsHtml = ''
  ;(devices || []).forEach(function(d) {
    var serial = escapeHtml(d.serial || '')
    var log = d.executionLog != null ? String(d.executionLog).trim() : ''
    if (log) {
      logsHtml += '<h3>设备 ' + serial + '</h3><pre class="log-pre">' + escapeHtml(log) + '</pre>'
    }
  })
  if (!logsHtml) {
    logsHtml = '<pre class="log-pre muted">（无详细日志）</pre>'
  }

  var runId = escapeHtml(run && run.id ? run.id : '')
  var caseRange = escapeHtml(formatCaseRangeLine(started, endedDisplay))
  var errorsPayload = JSON.stringify(replayErrorsJson).replace(/</g, '\\u003c')

  return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8"/>\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"/>\n' +
    '<title>录制回放测试报告 - ' + escapeHtml(name) + '</title>\n' +
    '<style>\n' +
    '*{box-sizing:border-box;}\n' +
    'body{margin:0;font-family:Segoe UI,Roboto,Helvetica,"PingFang SC","Microsoft YaHei",sans-serif;' +
    'background:#12141a;color:#e4e4e7;min-height:100vh;padding:24px 28px 48px;}\n' +
    'a{color:#93c5fd;}\n' +
    '.dash-header{display:flex;flex-wrap:wrap;gap:32px;align-items:flex-start;justify-content:space-between;' +
    'margin-bottom:28px;padding:24px 28px;background:linear-gradient(145deg,#1e2230 0%,#181b24 100%);' +
    'border-radius:12px;border:1px solid #2d3344;}\n' +
    '.dash-left{flex:1;min-width:280px;}\n' +
    '.pass-rate-big{font-size:42px;font-weight:700;color:#f9fafb;letter-spacing:-1px;line-height:1.1;}\n' +
    '.pass-rate-sub{font-size:13px;color:#9ca3af;margin-top:6px;}\n' +
    '.meta-list{margin-top:20px;font-size:13px;line-height:1.85;color:#d1d5db;}\n' +
    '.meta-row{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 8px;margin-bottom:6px;}\n' +
    '.meta-k{flex:0 0 auto;color:#9ca3af;font-weight:600;}\n' +
    '.meta-v{flex:1 1 200px;color:#e5e7eb;word-break:break-all;}\n' +
    '.dash-right{display:flex;align-items:center;gap:20px;flex-wrap:wrap;}\n' +
    '.pie-wrap{text-align:center;}\n' +
    '.pie-title{font-size:13px;color:#9ca3af;margin-bottom:10px;}\n' +
    '.pie-svg{display:block;filter:drop-shadow(0 4px 12px rgba(0,0,0,.35));}\n' +
    '.legend{font-size:13px;line-height:1.9;min-width:140px;}\n' +
    '.legend-row{display:flex;align-items:center;gap:8px;}\n' +
    '.swatch{width:10px;height:10px;border-radius:2px;flex-shrink:0;}\n' +
    '.sw-pass{background:#34d399;}.sw-fail{background:#f87171;}.sw-inv{background:#60a5fa;}.sw-blk{background:#fbbf24;}\n' +
    '.legend-total{margin-top:10px;padding-top:10px;border-top:1px solid #374151;color:#9ca3af;}\n' +
    'h1{font-size:18px;font-weight:600;color:#f3f4f6;margin:0 0 16px;}\n' +
    '.table-card{background:#1a1d26;border:1px solid #2d3344;border-radius:12px;overflow:hidden;margin-bottom:28px;}\n' +
    'table{width:100%;border-collapse:collapse;font-size:13px;}\n' +
    'thead th{text-align:left;padding:12px 14px;background:#232836;color:#9ca3af;font-weight:600;border-bottom:1px solid #2d3344;}\n' +
    'tbody td{padding:12px 14px;border-bottom:1px solid #2a2f3d;vertical-align:middle;}\n' +
    'tbody tr:hover{background:#22262f;}\n' +
    '.td-pass{color:#34d399;font-weight:600;}\n' +
    '.td-fail{color:#f87171;font-weight:600;}\n' +
    '.td-invalid{color:#60a5fa;}\n' +
    '.td-blocked{color:#fbbf24;}\n' +
    '.td-device code{background:#2d3344;padding:2px 8px;border-radius:4px;font-size:12px;color:#e5e7eb;}\n' +
    '.td-empty{text-align:center;color:#6b7280;padding:24px;}\n' +
    '.num-fail{background:none;border:none;color:#f87171;font-weight:700;font-size:inherit;font-family:inherit;' +
    'cursor:pointer;padding:0;text-decoration:underline;text-underline-offset:3px;}\n' +
    '.num-fail:hover{color:#fca5a5;}\n' +
    '.num-zero{color:#6b7280;font-weight:600;}\n' +
    '.link-action{white-space:nowrap;}\n' +
    'h2{font-size:15px;color:#e5e7eb;margin:28px 0 12px;font-weight:600;}\n' +
    '.detail-panels.hidden{display:none;}\n' +
    '.detail-hint{font-size:12px;color:#6b7280;margin:12px 0 0;padding:10px 12px;background:#1a1d26;border:1px dashed #374151;border-radius:8px;}\n' +
    'h3{font-size:14px;margin:12px 0 8px;color:#f3f4f6;}\n' +
    '.gallery{margin-top:8px;}\n' +
    '.fail-item{border:1px solid #2d3344;border-radius:10px;padding:16px;margin-bottom:16px;background:#1e2230;}\n' +
    '.screenshot-comparison{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start;}\n' +
    '.diff-text{margin-top:10px;font-size:13px;line-height:1.55;color:#d1d5db;}\n' +
    '.cap-label{font-size:12px;color:#9ca3af;margin-bottom:6px;}\n' +
    '.cap-note{font-size:11px;color:#6b7280;margin-top:6px;}\n' +
    '.device-tag{font-size:12px;color:#9ca3af;font-weight:normal;}\n' +
    '.muted{color:#6b7280;}\n' +
    '.log-pre{background:#0d0f14;color:#c9d1d9;padding:14px;border-radius:8px;overflow:auto;font-size:12px;border:1px solid #2d3344;}\n' +
    'code{background:#2d3344;padding:2px 6px;border-radius:4px;font-size:12px;color:#e5e7eb;}\n' +
    '.fail-item img{max-width:min(360px,90vw);max-height:640px;border:1px solid #374151;border-radius:6px;}\n' +
    '.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:1000;' +
    'align-items:center;justify-content:center;padding:20px;}\n' +
    '.modal-overlay.open{display:flex;}\n' +
    '.modal-box{background:#1e2230;border:1px solid #3d4659;border-radius:12px;max-width:560px;width:100%;' +
    'max-height:80vh;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 20px 50px rgba(0,0,0,.5);}\n' +
    '.modal-head{padding:16px 20px;border-bottom:1px solid #2d3344;display:flex;justify-content:space-between;align-items:center;}\n' +
    '.modal-head h3{margin:0;font-size:16px;color:#f9fafb;}\n' +
    '.modal-close{background:#2d3344;border:none;color:#e5e7eb;width:32px;height:32px;border-radius:8px;' +
    'cursor:pointer;font-size:20px;line-height:1;}\n' +
    '.modal-close:hover{background:#3d4659;}\n' +
    '.modal-body{padding:16px 20px;overflow-y:auto;font-size:13px;line-height:1.6;color:#d1d5db;}\n' +
    '.modal-body ul{margin:0;padding-left:18px;}\n' +
    '.modal-body li{margin-bottom:10px;word-break:break-word;}\n' +
    '.modal-empty{color:#6b7280;font-style:italic;}\n' +
    '</style>\n</head>\n<body>\n' +
    '<h1>Replay 测试报告 · ' + escapeHtml(name) + '</h1>\n' +
    '<div class="dash-header">\n' +
    '  <div class="dash-left">\n' +
    '    <div class="pass-rate-big">' + escapeHtml(passRateStr) + '</div>\n' +
    '    <div class="pass-rate-sub">用例通过率（通过断言 / 总断言）</div>\n' +
    '    <div class="meta-list">\n' +
    '      <div class="meta-row"><span class="meta-k">报告 ID：</span><span class="meta-v">' + runId + '</span></div>\n' +
    '      <div class="meta-row"><span class="meta-k">结果：</span><span class="meta-v">' + resultsLine + '</span></div>\n' +
    '      <div class="meta-row"><span class="meta-k">目标设备：</span><span class="meta-v">' + targetLine + '</span></div>\n' +
    '      <div class="meta-row"><span class="meta-k">时间范围：</span><span class="meta-v">' + caseRange + '</span></div>\n' +
    '      <div class="meta-row"><span class="meta-k">执行人：</span><span class="meta-v">' + executor + '</span></div>\n' +
    '    </div>\n' +
    '  </div>\n' +
    '  <div class="dash-right">\n' +
    '    <div class="pie-wrap">\n' +
    '      <div class="pie-title">回放通过率</div>\n' +
    '      <svg class="pie-svg" width="200" height="200" viewBox="0 0 200 200">' + piePaths + '</svg>\n' +
    '    </div>\n' +
    '    <div class="legend">\n' +
    '      <div class="legend-row"><span class="swatch sw-pass"></span>通过 <strong style="color:#e5e7eb">' + String(totalPass) + '</strong></div>\n' +
    '      <div class="legend-row"><span class="swatch sw-fail"></span>失败 <strong style="color:#e5e7eb">' + String(totalFail) + '</strong></div>\n' +
    '      <div class="legend-row"><span class="swatch sw-inv"></span>无效 <strong style="color:#e5e7eb">' + String(invalidCount) + '</strong></div>\n' +
    '      <div class="legend-row"><span class="swatch sw-blk"></span>阻塞 <strong style="color:#e5e7eb">' + String(blockedCount) + '</strong></div>\n' +
    '      <div class="legend-total">总用例 <strong style="color:#f3f4f6">' + String(totalCases) + '</strong></div>\n' +
    '    </div>\n' +
    '  </div>\n' +
    '</div>\n' +
    '<div class="table-card">\n' +
    '  <table>\n' +
    '    <thead><tr>' +
    '<th>设备</th><th>用例数</th><th>通过</th><th>失败</th><th>无效</th><th>阻塞</th><th>操作</th>' +
    '</tr></thead>\n' +
    '    <tbody>' + tableRows + '</tbody>\n' +
    '  </table>\n' +
    '</div>\n' +
    '<p class="detail-hint">失败截图与执行日志默认折叠。点击上表中的「截图区」「定位」或「日志」后展开并自动滚动到对应位置。</p>\n' +
    '<section id="replay-detail-panels" class="detail-panels hidden" aria-hidden="true">\n' +
    '<h2 id="gallery-top">失败截图与详情 (' + String(galleryCount) + ' 条)</h2>\n' +
    (galleryCount ? '<div class="gallery">' + galleryHtml + '</div>\n' :
      '<p class="muted">无失败截图条目（可能无断言失败或未采集截图）。</p>\n') +
    '<h2 id="exec-log-top">执行日志</h2>\n' + logsHtml + '\n' +
    '</section>\n' +
    '<div id="err-modal" class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="err-modal-title">\n' +
    '  <div class="modal-box">\n' +
    '    <div class="modal-head">\n' +
    '      <h3 id="err-modal-title">失败详情</h3>\n' +
    '      <button type="button" class="modal-close" id="err-modal-close" aria-label="关闭">×</button>\n' +
    '    </div>\n' +
    '    <div class="modal-body" id="err-modal-body"></div>\n' +
    '  </div>\n' +
    '</div>\n' +
    '<script id="replay-errors-data" type="application/json">' + errorsPayload + '</script>\n' +
    '<script>\n' +
    '(function(){\n' +
    '  var el = document.getElementById("replay-errors-data");\n' +
    '  var map = {};\n' +
    '  try { map = JSON.parse(el.textContent || "{}"); } catch (e) {}\n' +
    '  var overlay = document.getElementById("err-modal");\n' +
    '  var body = document.getElementById("err-modal-body");\n' +
    '  function openModal(key) {\n' +
    '    var list = map[key] || [];\n' +
    '    if (!list.length) {\n' +
    '      body.innerHTML = "<p class=\\"modal-empty\\">暂无结构化错误信息（可查看下方截图区与日志）。</p>";\n' +
    '    } else {\n' +
    '      body.innerHTML = "<ul>" + list.map(function(t) {\n' +
    '        return "<li>" + String(t).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;") + "</li>";\n' +
    '      }).join("") + "</ul>";\n' +
    '    }\n' +
    '    overlay.classList.add("open");\n' +
    '  }\n' +
    '  function closeModal() { overlay.classList.remove("open"); }\n' +
    '  document.querySelectorAll(".js-fail-btn").forEach(function(btn) {\n' +
    '    btn.addEventListener("click", function() { openModal(btn.getAttribute("data-err-key")); });\n' +
    '  });\n' +
    '  document.getElementById("err-modal-close").addEventListener("click", closeModal);\n' +
    '  overlay.addEventListener("click", function(ev) { if (ev.target === overlay) closeModal(); });\n' +
    '  document.addEventListener("keydown", function(ev) { if (ev.key === "Escape") closeModal(); });\n' +
    '  var detailPanel = document.getElementById("replay-detail-panels");\n' +
    '  function openDetailPanels() {\n' +
    '    if (!detailPanel) return;\n' +
    '    detailPanel.classList.remove("hidden");\n' +
    '    detailPanel.setAttribute("aria-hidden", "false");\n' +
    '  }\n' +
    '  document.querySelectorAll(".js-open-details").forEach(function(a) {\n' +
    '    a.addEventListener("click", function(ev) {\n' +
    '      ev.preventDefault();\n' +
    '      openDetailPanels();\n' +
    '      var id = a.getAttribute("data-scroll");\n' +
    '      if (!id) return;\n' +
    '      setTimeout(function() {\n' +
    '        var t = document.getElementById(id);\n' +
    '        if (t) { t.scrollIntoView({ behavior: "smooth", block: "start" }); }\n' +
    '      }, 50);\n' +
    '    });\n' +
    '  });\n' +
    '})();\n' +
    '</script>\n' +
    '</body>\n</html>'
}

function monkeyDeviceFailed(d) {
  return d.status === 'failed' || (d.error != null && String(d.error).trim() !== '')
}

function monkeyDeviceSucceeded(d) {
  return !monkeyDeviceFailed(d) && (d.status === 'finished' || d.status === 'done')
}

/**
 * @param {object} run
 * @param {Array} devices — automationMonkeyRunDevices rows
 */
function buildMonkeyTestReportHtml(run, devices) {
  var ds = devices || []
  var pkg = escapeHtml(run && run.packageName ? run.packageName : '')
  var started = formatLocalTime(run && (run.startedAt || run.createdAt))
  var endedIso = (run && run.endedAt) || inferLatestDeviceEndedAt(ds)
  var ended = formatLocalTime(endedIso)
  var runId = escapeHtml(run && run.id ? run.id : '')

  var successCount = ds.filter(monkeyDeviceSucceeded).length
  var failureCount = ds.filter(monkeyDeviceFailed).length
  var pendingCount = ds.length - successCount - failureCount
  var rateStr = '—'
  if (ds.length > 0) {
    rateStr = (Math.round(successCount / ds.length * 1000) / 10).toFixed(1) + '%'
  }
  var runStatusLine = replayStatusLabel(run && run.status ? run.status : '')

  var rows = ds.map(function(d) {
    return '<tr>' +
      '<td>' + escapeHtml(d.serial) + '</td>' +
      '<td>' + escapeHtml(d.deviceName || '') + '</td>' +
      '<td>' + escapeHtml(replayStatusLabel(d.status || '')) + '</td>' +
      '<td>' + escapeHtml(d.error || '') + '</td>' +
      '<td>' + escapeHtml(formatLocalTime(d.startedAt)) + '</td>' +
      '<td>' + escapeHtml(formatLocalTime(d.endedAt)) + '</td>' +
      '</tr>'
  }).join('')

  var pendingLine = pendingCount > 0
    ? '<p>进行中设备数: ' + String(pendingCount) + '</p>\n'
    : ''

  return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8"/>\n' +
    '<title>Monkey 测试报告 - ' + pkg + '</title>\n' +
    '<style>\n' +
    'body{font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:24px;}\n' +
    'table{border-collapse:collapse;width:100%;font-size:13px;}\n' +
    'th,td{border:1px solid #ccc;padding:8px;text-align:left;}\n' +
    'th{background:#f0f0f0;}\n' +
    '.summary{margin:12px 0;padding:12px 16px;background:#f7f7f7;border-radius:6px;font-size:14px;line-height:1.7;}\n' +
    '</style>\n</head>\n<body>\n' +
    '<h1>Monkey 测试报告</h1>\n' +
    '<p>运行ID: ' + runId + ' &nbsp; 包名: <strong>' + pkg + '</strong></p>\n' +
    '<p>运行状态: ' + escapeHtml(runStatusLine) + '</p>\n' +
    '<p>开始: ' + escapeHtml(started) + ' &nbsp; 结束: ' + escapeHtml(ended) + '</p>\n' +
    '<div class="summary">\n' +
    '  <div>成功数: <strong>' + String(successCount) + '</strong></div>\n' +
    '  <div>失败数: <strong>' + String(failureCount) + '</strong></div>\n' +
    '  <div>成功率: <strong>' + escapeHtml(rateStr) + '</strong>（成功设备 / 总设备）</div>\n' +
    '</div>\n' +
    pendingLine +
    '<table><thead><tr><th>序列号</th><th>设备名</th><th>状态</th><th>错误</th><th>开始</th><th>结束</th></tr></thead>\n' +
    '<tbody>' + (rows || '<tr><td colspan="6">无数据</td></tr>') + '</tbody></table>\n' +
    '</body>\n</html>'
}

/**
 * Before building replay HTML, embed expected screenshots as data URLs when missing
 * (fixes /x/image vs /s/image and expired temp storage if API can still fetch).
 */
function enrichReplayDevicesWithBaselineImages(devices, recording) {
  if (!Array.isArray(devices)) {
    return Promise.resolve(devices)
  }
  var metaList = recording && Array.isArray(recording.baselinesMeta) ? recording.baselinesMeta : null
  return Promise.map(devices, function(d) {
    var arts = d && Array.isArray(d.reportArtifacts) ? d.reportArtifacts : null
    if (!arts || !arts.length) {
      return d
    }
    return Promise.map(arts, function(art) {
      if (!art || art.expectedImageDataUrl) {
        return null
      }
      if (metaList) {
        var bix = Number(art.baselineIndex)
        if (isFinite(bix) && bix >= 0 && metaList[bix] && metaList[bix].inlineDataUrl) {
          art.expectedImageDataUrl = metaList[bix].inlineDataUrl
          return null
        }
      }
      var href = null
      if (metaList) {
        var bi2 = Number(art.baselineIndex)
        if (isFinite(bi2) && bi2 >= 0 && metaList[bi2] && metaList[bi2].href) {
          href = metaList[bi2].href
        }
      }
      if (!href) {
        href = art.expectedImageHref
      }
      if (!href) {
        return null
      }
      var abs = visualCompare.resolveBaselineAbsoluteUrl(href)
      if (!abs) {
        return null
      }
      return visualCompare.fetchUrlToBuffer(abs)
        .then(function(buf) {
          var du = visualCompare.bufferToDataUrl(buf)
          if (du) {
            art.expectedImageDataUrl = du
          }
        })
        .catch(function() {
          /* keep href fallback */
        })
    }).then(function() {
      return d
    })
  }).then(function() {
    return devices
  })
}

module.exports = {
  escapeHtml: escapeHtml
, buildReplayTestReportHtml: buildReplayTestReportHtml
, buildMonkeyTestReportHtml: buildMonkeyTestReportHtml
, enrichReplayDevicesWithBaselineImages: enrichReplayDevicesWithBaselineImages
}
