package plugins

// ResetRegistryForTestPublic is exported so cross-package tests can reset
// the global registry. NOT for production use.
var ResetRegistryForTestPublic = resetRegistryForTest
