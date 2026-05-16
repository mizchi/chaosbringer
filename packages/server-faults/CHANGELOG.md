# Changelog

## [1.0.0](https://github.com/mizchi/chaosbringer/compare/server-faults-v0.1.0...server-faults-v1.0.0) (2026-05-16)


### ⚠ BREAKING CHANGES

* **server-faults:** maybeInject returns FaultVerdict (synthetic/annotate/null)
* **server-faults:** flat camelCase FaultAttrs + traceId + toOtelAttrs translator
* **server-faults:** observer.onFault attrs now use `fault.*` namespaced keys (`fault.path`, `fault.method`, `fault.target_status`, `fault.latency_ms`, `fault.kind`) instead of the old `path`, `status`, `ms`. Consumers reading individual keys must rename. Consumers using only the `kind` argument are unaffected.

### Features

* **server-faults/express:** support FaultVerdict + metadataHeader stamping ([1fbdad0](https://github.com/mizchi/chaosbringer/commit/1fbdad044902a4f9cee816d09b48c657394bf093))
* **server-faults/fastify:** support FaultVerdict + metadataHeader stamping ([3ab0bbf](https://github.com/mizchi/chaosbringer/commit/3ab0bbfe5d9c4115c51fee3fb4fb1ff600cf4fc3))
* **server-faults/hono:** support FaultVerdict + metadataHeader stamping ([e59f6d1](https://github.com/mizchi/chaosbringer/commit/e59f6d1d44f59b6837d5a695e4d1915159b33179))
* **server-faults/koa:** support FaultVerdict + metadataHeader stamping ([d090f1d](https://github.com/mizchi/chaosbringer/commit/d090f1d8e9f0601aa702ba7dc4ec14ff159904e4))
* **server-faults:** add @mizchi/server-faults package ([#43](https://github.com/mizchi/chaosbringer/issues/43)) ([89482e7](https://github.com/mizchi/chaosbringer/commit/89482e77d669f03bb57112158c1b6d6f95970caa))
* **server-faults:** add bypassHeader / exemptPathPattern ([#65](https://github.com/mizchi/chaosbringer/issues/65)) ([fb56946](https://github.com/mizchi/chaosbringer/commit/fb569461d3d7e0e50d24036f3a3521008533fd83))
* **server-faults:** add hono / express / fastify / koa adapters ([ca05ae7](https://github.com/mizchi/chaosbringer/commit/ca05ae7565ebd2282b245d956fc64e9aabc50350))
* **server-faults:** add metadataHeader option (mirror fault attrs to response headers) ([207ec51](https://github.com/mizchi/chaosbringer/commit/207ec51d899b5e3c3dde6633c02b93a1cfab55bf))
* **server-faults:** flat camelCase FaultAttrs + traceId + toOtelAttrs translator ([34f1937](https://github.com/mizchi/chaosbringer/commit/34f19374003c2b6bc8b22b3df1f3af5224e0d1ee))
* **server-faults:** maybeInject returns FaultVerdict (synthetic/annotate/null) ([fb7dd7e](https://github.com/mizchi/chaosbringer/commit/fb7dd7ef845513c57251558f5827c5ce36fb4201))
* **server-faults:** re-export toOtelAttrs + table-drive the translation ([0a4a6b3](https://github.com/mizchi/chaosbringer/commit/0a4a6b37ef22bed33f30c6d35114c1d61074e9e4))
* **server-faults:** stabilise observer.onFault attrs schema ([2af0d1a](https://github.com/mizchi/chaosbringer/commit/2af0d1adf91b4363225d0c96aaa6a9348a9f7d93))


### Bug Fixes

* **server-faults/hono:** exhaustive verdict narrowing + freeze-headers note + tighter test ([09e73ba](https://github.com/mizchi/chaosbringer/commit/09e73bae8beb38717193d8f190a9c49156fe6804))
* **server-faults:** add prepare: tsc so dist/ is populated before publish ([#54](https://github.com/mizchi/chaosbringer/issues/54)) ([4e825a7](https://github.com/mizchi/chaosbringer/commit/4e825a70d9ac93c8b99d1d426adae371184a7e02))
* **server-faults:** freeze attrs to prevent observer/verdict aliasing mutation ([15fecb1](https://github.com/mizchi/chaosbringer/commit/15fecb1e6678fb22d1e54678347f1f7410ccb91a))
* **server-faults:** make pathPattern / exemptPathPattern matching stateless ([9724621](https://github.com/mizchi/chaosbringer/commit/97246215e099e121262686b9fe17a3ec36ee69f7))
* **server-faults:** table-drive header key encoding to lock wire format ([1949672](https://github.com/mizchi/chaosbringer/commit/194967275660b2958f14aa9838536a2a84e95b6e))
