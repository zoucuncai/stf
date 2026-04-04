/* Based on https://ryankaskel.com/blog/2013/05/27/
 a-different-approach-to-angularjs-navigation-menus */

module.exports = function($location) {
  return {
    restrict: 'EA',
    scope: {},
    link: function(scope, element, attrs) {
      var onClass = attrs.navMenu || 'current'
      var link, url

      function hrefToPath(href) {
        if (!href) {
          return ''
        }
        var h = href.replace(/\/{{[^}]*}}/g, '')
        var bang = h.indexOf('#!')
        if (bang >= 0) {
          return h.slice(bang + 2).split('?')[0] || ''
        }
        return h
      }

      function buildUrlMap() {
        var urlMap = []
        var anchors = element.find('a')
        for (var i = 0; i < anchors.length; i++) {
          link = angular.element(anchors[i])
          url = link.attr('ng-href') || link.attr('href') || ''
          url = url.replace(/\/{{[^}]*}}/g, '')
          var path = hrefToPath(url)
          if (path) {
            urlMap.push({path: path, link: link})
          }
        }
        return {anchors: anchors, urlMap: urlMap}
      }

      function activateLink() {
        var built = buildUrlMap()
        var anchors = built.anchors
        var urlMap = built.urlMap
        var location = $location.path()
        var pathLink = null
        var bestLen = -1

        // Prefer exact path matches so /devices/automation does not highlight /devices.
        for (var e = 0; e < urlMap.length; ++e) {
          var pe = urlMap[e].path
          if (pe && location === pe && pe.length > bestLen) {
            bestLen = pe.length
            pathLink = urlMap[e].link
          }
        }

        if (!pathLink) {
          bestLen = -1
          for (var i = 0; i < urlMap.length; ++i) {
            var p = urlMap[i].path
            if (!p || p === '/') {
              continue
            }
            if (location.indexOf(p + '/') === 0 && p.length > 1) {
              if (p.length > bestLen) {
                bestLen = p.length
                pathLink = urlMap[i].link
              }
            }
          }
        }

        // Remove all active links in this nav block (re-scan anchors each time).
        for (var j = 0; j < anchors.length; j++) {
          link = angular.element(anchors[j])
          link.removeClass(onClass)
        }

        if (pathLink) {
          pathLink.addClass(onClass)
        }
      }

      activateLink()
      scope.$on('$routeChangeSuccess', activateLink)
      // Links inside ng-if may appear after first link(); refresh highlight after digest.
      scope.$evalAsync(function() {
        activateLink()
      })
    }
  }
}
