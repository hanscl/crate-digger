import { Mastra } from "@mastra/core/mastra";
import { ConsoleLogger } from "@mastra/core/logger";
import { bucketNamerAgent } from "./agents/bucket-namer";
import { playlistParserAgent } from "./agents/playlist-parser";
import { whySurfacedAgent } from "./agents/why-surfaced";
import { dailyPipeline } from "./workflows/daily-pipeline";

/**
 * Single Mastra instance the rest of the app uses to start workflow runs and
 * fetch agents. Importing this file boots Mastra; consumers should re-use
 * `mastra` rather than calling `new Mastra(...)` themselves.
 *
 * `mastra dev` (the Studio sidecar) discovers this same export, so the
 * dashboard and the running app share one workflow registry.
 */
export const mastra = new Mastra({
  agents: {
    bucketNamer: bucketNamerAgent,
    whySurfaced: whySurfacedAgent,
    playlistParser: playlistParserAgent,
  },
  workflows: {
    dailyPipeline,
  },
  logger: new ConsoleLogger({ level: "info" }),
});
