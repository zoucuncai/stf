/**
 * Packages installed with persist_after_session are not removed by cleanup on group leave.
 * Registry is per device worker process (cleared on worker restart).
 */
var persistentPkgs = Object.create(null)

module.exports = {
  markPersistent: function(pkg) {
    if (pkg) {
      persistentPkgs[pkg] = true
    }
  }
, skipCleanup: function(pkg) {
    return !!persistentPkgs[pkg]
  }
}
