const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

let capturedSecret = null;

function validSecret(value) {
  return SECRET_PATTERN.test(String(value || "")) ? String(value) : null;
}

export function captureDesktopAuthorizationSecret(windowObject = window) {
  if (windowObject.location.pathname !== "/desktop/authorize") return null;
  const rawFragment = windowObject.location.hash.replace(/^#/, "");
  if (!rawFragment) return null;

  const parameters = new URLSearchParams(rawFragment);
  const secret = validSecret(parameters.get("request"));
  const hasUnexpectedParameter = [...parameters.keys()].some((key) => key !== "request");
  if (!secret || hasUnexpectedParameter) {
    clearDesktopAuthorizationSecret(windowObject);
    if (parameters.has("request")) {
      windowObject.history.replaceState(
        windowObject.history.state,
        "",
        `${windowObject.location.pathname}${windowObject.location.search}`,
      );
    }
    return null;
  }

  capturedSecret = secret;
  windowObject.history.replaceState(
    windowObject.history.state,
    "",
    `${windowObject.location.pathname}${windowObject.location.search}`,
  );
  return secret;
}

export function readDesktopAuthorizationSecret(windowObject = window) {
  void windowObject;
  return capturedSecret;
}

export function clearDesktopAuthorizationSecret(windowObject = window) {
  void windowObject;
  capturedSecret = null;
}
