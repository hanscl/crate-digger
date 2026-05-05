import { z } from "zod";
import { exportTaste } from "@/lib/taste/export";
import { importTaste } from "@/lib/taste/import";
import { TASTE_EXPORT_SCHEMA } from "@/lib/taste/schema";
import { protectedProcedure, router } from "../trpc";

/**
 * Taste profile export/import — Constraint #8. The deterministic core lives
 * in `src/lib/taste/`; this router is a thin auth boundary.
 */
export const tasteRouter = router({
  export: protectedProcedure.query(async ({ ctx }) => {
    return exportTaste(ctx.db);
  }),

  import: protectedProcedure
    .input(z.object({ payload: TASTE_EXPORT_SCHEMA }))
    .mutation(async ({ ctx, input }) => {
      return importTaste(ctx.db, input.payload);
    }),
});
