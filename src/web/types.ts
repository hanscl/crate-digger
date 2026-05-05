import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/server/trpc";

export type RouterOutputs = inferRouterOutputs<AppRouter>;
