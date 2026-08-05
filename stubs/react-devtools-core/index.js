// A stand-in for the optional peer Ink reaches for behind its DEV guard.
//
// The real package is never wanted here: garden sets nothing up for React
// devtools, and the guard in ink/build/reconciler.js only *runs* any of this
// when DEV=true. But `bun build --compile` must resolve every static import it
// can reach, the guard's dynamic import edge survives bundling, and
// devtools.js imports this package unconditionally — so something resolvable
// has to exist. This is that something: the two calls devtools.js makes, doing
// nothing.
export default {
  initialize() {},
  connectToDevTools() {},
};
