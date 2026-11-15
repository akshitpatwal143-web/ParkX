/**
 * Express 4 Async Handler Wrapper
 *
 * Express 4 does not await promises returned by route handlers or middleware.
 * If an async route handler rejects or continues executing after sending a response,
 * Express 4 ignores the returned promise, risking unhandled rejections and premature
 * shutdown while asynchronous operations are still in-flight.
 *
 * wrapAsyncHandler:
 * 1. Registers the handler's returned promise as active work with the handler tracker.
 * 2. Keeps the work count active after res.json(), res.send(), or res.end() if the handler
 *    continues executing background asynchronous work.
 * 3. Releases the work count only after the returned promise settles (resolved or rejected).
 * 4. Correctly forwards rejected promises to Express error handling (next(err)).
 * 5. Does not create discarded rejecting promises or unhandled rejections.
 * 6. Handles synchronous exceptions safely.
 */

export class HandlerTracker {
  constructor() {
    this.activePromises = new Set();
  }

  track(promise) {
    if (promise && typeof promise.then === 'function') {
      this.activePromises.add(promise);
      let settled = false;
      const release = () => {
        if (!settled) {
          settled = true;
          this.activePromises.delete(promise);
        }
      };
      promise.then(release, release);
    }
    return promise;
  }

  getActiveCount() {
    return this.activePromises.size;
  }
}

export function wrapAsyncHandler(fn, customTracker) {
  if (typeof fn !== 'function') {
    throw new TypeError('wrapAsyncHandler expects a function');
  }

  if (fn._isWrappedAsync) {
    return fn;
  }

  // 4-argument error handler middleware: (err, req, res, next)
  if (fn.length === 4) {
    const wrappedErrorHandler = function asyncErrorHandler(err, req, res, next) {
      let result;
      try {
        result = fn(err, req, res, next);
      } catch (syncErr) {
        return next(syncErr);
      }

      if (result && typeof result.then === 'function') {
        const tracker = customTracker || req?.app?.trackHandlerWork;
        if (typeof tracker === 'function') {
          tracker(result);
        }
        result.catch((asyncErr) => {
          next(asyncErr);
        });
      }

      return result;
    };
    wrappedErrorHandler._isWrappedAsync = true;
    return wrappedErrorHandler;
  }

  // Standard route handlers and middleware: (req, res, next)
  const wrappedRouteHandler = function asyncRouteHandler(req, res, next) {
    let result;
    try {
      result = fn(req, res, next);
    } catch (syncErr) {
      return next(syncErr);
    }

    if (result && typeof result.then === 'function') {
      const tracker = customTracker || req?.app?.trackHandlerWork;
      if (typeof tracker === 'function') {
        tracker(result);
      }
      result.catch((asyncErr) => {
        next(asyncErr);
      });
    }

    return result;
  };
  wrappedRouteHandler._isWrappedAsync = true;
  return wrappedRouteHandler;
}
