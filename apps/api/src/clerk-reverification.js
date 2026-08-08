export function isClerkReverificationRequired(error) {
  return error?.clerkReverification === "strict";
}

export function clerkReverificationResponse(c, level = "strict") {
  return c.json({
    clerk_error: {
      type: "forbidden",
      reason: "reverification-error",
      metadata: {
        reverification: level,
      },
    },
  }, 403);
}
