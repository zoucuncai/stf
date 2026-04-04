var Promise = require('bluebird')

module.exports = function StorageServiceFactory($http, Upload) {
  var service = {}

  // POST /s/upload returns resources keyed by multipart field names. ng-file-upload uses
  // "file" for a single File, but "file[0]", "file[1]", ... for an array — so resources.file may be absent.
  service.getFileResourceFromResponse = function(response) {
    var data = response && response.data
    if (!data || !data.resources) {
      return null
    }
    var resources = data.resources
    if (resources.file) {
      return resources.file
    }
    var keys = Object.keys(resources)
    return keys.length ? resources[keys[0]] : null
  }

  service.storeUrl = function(type, url) {
    return $http({
      url: '/s/download/' + type
    , method: 'POST'
    , data: {
        url: url
      }
    })
  }

  service.storeFile = function(type, files, options) {
    var resolver = Promise.defer()
    var input = options.filter ? files.filter(options.filter) : files

    if (input.length) {
      // Single file must be passed as a File, not [File], or the field name becomes file[0] and
      // clients expecting resources.file break.
      var fileField = input.length === 1 ? input[0] : input
      Upload.upload({
          url: '/s/upload/' + type
        , method: 'POST'
        , file: fileField
        })
        .then(
          function(value) {
            resolver.resolve(value)
          }
        , function(err) {
            resolver.reject(err)
          }
        , function(progressEvent) {
            resolver.progress(progressEvent)
          }
        )
    }
    else {
      var err = new Error('No input files')
      err.code = 'no_input_files'
      resolver.reject(err)
    }

    return resolver.promise
  }

  return service
}
