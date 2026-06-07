import { describe, expect, it } from "vitest";
import { spotifyEmbedUrl, spotifySearchUrl } from "@/web/screens/queue-urls";

describe("spotifyEmbedUrl", () => {
  it("builds the open.spotify embed URL for a track id", () => {
    expect(spotifyEmbedUrl("abc123")).toBe("https://open.spotify.com/embed/track/abc123");
  });
});

describe("spotifySearchUrl", () => {
  it("URL-encodes the 'artist title' query", () => {
    expect(spotifySearchUrl("Boards of Canada", "Roygbiv")).toBe(
      `https://open.spotify.com/search/${encodeURIComponent("Boards of Canada Roygbiv")}`,
    );
  });

  it("encodes spaces as %20", () => {
    expect(spotifySearchUrl("Boards of Canada", "Roygbiv")).toContain("%20");
  });

  it("encodes special characters like slashes so they don't break the path", () => {
    const url = spotifySearchUrl("AC/DC", "T.N.T.");
    const query = url.slice("https://open.spotify.com/search/".length);
    expect(query).toContain("%2F");
    expect(query).not.toContain("/");
  });
});
