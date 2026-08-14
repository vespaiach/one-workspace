// Preload stub: neutralise server-only so auth modules can be imported in tests.
const Module = require('module')
const path = require('path')

const resolved = require.resolve('server-only')
Module._cache[resolved] = {
  id: resolved,
  filename: resolved,
  loaded: true,
  exports: {},
  children: [],
  parent: null,
  paths: []
}
