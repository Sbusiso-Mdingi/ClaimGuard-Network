import { initTRPC } from "@trpc/server";
import { z } from "zod";

import { trpcPingResponseSchema } from "@claimguard/shared-schema";

const t = initTRPC.create();

export const backendRouter = t.router({
  ping: t.procedure.query(() => {
    return trpcPingResponseSchema.parse({
      service: "api",
      message: "pong",
    });
  }),
  echo: t.procedure
    .input(z.object({ message: z.string().min(1) }))
    .mutation(({ input }) => {
      return {
        service: "api",
        message: input.message,
      };
    }),
});

export const backendRouterPath = "/trpc";