'use strict'

var util = require('util')
var http = require('http')
var EventEmitter = require('events').EventEmitter
var concat = require('concat-stream')
var plist = require('plist')
var bplistEncode = require('bplist-creator')
var bplistDecode = require('bplist-parser').parseBuffer
var reverseHttp = require('reverse-http')

var USER_AGENT = 'iTunes/11.0.2'
var noop = function () {}

module.exports = AirPlay

util.inherits(AirPlay, EventEmitter)

function AirPlay (host, port) {
  if (!(this instanceof AirPlay)) return new AirPlay(host, port)

  EventEmitter.call(this)

  this.host = host
  this.port = port || 7000
  this.state = null
  this._rserver = null
  this._agent = new http.Agent({
    keepAlive: true,
    maxSockets: 1
  })
}

AirPlay.prototype.close = function close (cb) {
  if (this._rserver) this._rserver.close(cb)
}

AirPlay.prototype.destroy = function destroy () {
  if (this._rserver) this._rserver.destroy()
  this._agent.destroy()
}

AirPlay.prototype.serverInfo = function serverInfo (cb) {
  this._get('/server-info', cb)
}

AirPlay.prototype.play = function play (url, position, cb) {
  if (typeof position === 'function') return this.play(url, 0, position)

  this._startReverse()

  var body = {
    'Content-Location': url,
    'Start-Position': position
  }

  this._post('/play', body, cb || noop)
}

AirPlay.prototype.scrub = function scrub (position, cb) {
  if (typeof position === 'function') return this.scrub(null, position)

  var method, path
  if (position === null) {
    method = 'GET'
    path = '/scrub'
  } else {
    method = 'POST'
    path = '/scrub?position=' + position
  }

  this._request(method, path, cb || noop)
}

AirPlay.prototype.rate = function rate (speed, cb) {
  this._post('/rate?value=' + speed, cb || noop)
}

AirPlay.prototype.pause = function pause (cb) {
  this.rate(0, cb)
}

AirPlay.prototype.resume = function pause (cb) {
  this.rate(1, cb)
}

AirPlay.prototype.stop = function stop (cb) {
  this._post('/stop', cb || noop)
}

AirPlay.prototype.playbackInfo = function playbackInfo (cb) {
  this._get('/playback-info', cb)
}

AirPlay.prototype.property = function property (name, value, cb) {
  if (typeof value === 'function') return this.property(name, null, value)

  var method, path
  if (value === null) {
    method = 'POST'
    path = '/getProperty?' + name
  } else {
    method = 'PUT'
    path = '/setProperty?' + name
  }

  this._request(method, path, value, cb)
}

AirPlay.prototype._get = function _get (path, body, cb) {
  this._request('GET', path, body, cb)
}

AirPlay.prototype._post = function _post (path, body, cb) {
  this._request('POST', path, body, cb)
}

AirPlay.prototype._request = function _request (method, path, body, cb) {
  if (typeof body === 'function') return this._request(method, path, null, body)

  var opts = {
    host: this.host,
    port: this.port,
    method: method,
    path: path,
    headers: {
      'User-Agent': USER_AGENT
    },
    agent: this._agent // The Apple TV will refuse to play if the play socket is closed
  }

  if (body && typeof body === 'object') {
    body = bplistEncode(body)
    opts.headers['Content-Type'] = 'application/x-apple-binary-plist'
    opts.headers['Content-Length'] = body.length
  } else if (typeof body === 'string') {
    opts.headers['Content-Type'] = 'text/parameters'
    opts.headers['Content-Length'] = Buffer.byteLength(body)
  } else {
    opts.headers['Content-Length'] = 0
  }

  var req = http.request(opts, function (res) {
    if (res.statusCode !== 200) var err = new Error('Unexpected response from Apple TV: ' + res.statusCode)

    var buffers = []
    res.on('data', buffers.push.bind(buffers))
    res.on('end', function () {
      var body = Buffer.concat(buffers)

      switch (res.headers['content-type']) {
        case 'application/x-apple-binary-plist':
          body = bplistDecode(body)[0]
          break
        case 'text/x-apple-plist+xml':
          body = plist.parse(body.toString())
          break
        case 'text/parameters':
          body = body.toString().trim().split('\n').reduce(function (body, line) {
            line = line.split(': ')
            // TODO: For now it's only floats, but it might be better to not expect that
            body[line[0]] = parseFloat(line[1], 10)
            return body
          }, {})
          break
      }

      cb(err, res, body)
    })
  })

  req.end(body)
}

AirPlay.prototype._startReverse = function _startReverse () {
  if (this._rserver) this._rserver.destroy()

  var self = this
  var opts = {
    host: this.host,
    port: this.port,
    path: '/reverse',
    headers: {
      'User-Agent': USER_AGENT
    }
  }

  this._rserver = reverseHttp(opts, function (req, res) {
    if (req.method !== 'POST' || req.url !== '/event') {
      // TODO: Maybe we should just accept it silently?
      res.statusCode = 404
      res.end()
      return
    }

    req.pipe(concat(function (data) {
      res.end()

      switch (req.headers['content-type']) {
        case 'text/x-apple-plist+xml':
        case 'application/x-apple-plist':
          data = plist.parse(data.toString())
          if (data && data.state) {
            self.state = data.state
            if (self.state === 'stopped') self.destroy()
          }
          break
      }

      self.emit('event', data)
    }))
  })
}
