import { describe, expect, it } from "vitest";
import { EMBEDDING_DIM, appConfig, bucket, surfaceEvent, track } from "@/db/schema";

describe("schema", () => {
  it("uses a stable embedding dimensionality", () => {
    expect(EMBEDDING_DIM).toBe(64);
  });

  it("declares the load-bearing tables", () => {
    expect(track).toBeDefined();
    expect(bucket).toBeDefined();
    expect(surfaceEvent).toBeDefined();
    expect(appConfig).toBeDefined();
  });
});
