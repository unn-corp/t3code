package com.devotek.t3code.pwa;

import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** The subset of a GitHub release the updater trusts for discovery. The manifest decides eligibility. */
final class ReleaseRef {
    static final class AssetRef {
        final String name;
        final long size;
        AssetRef(String name, long size) { this.name = name; this.size = size; }
    }
    final String tag;
    final boolean draft, prerelease;
    /** True when the release notes begin a line with the fork's withdrawal marker. */
    final boolean withdrawn;
    final long publishedAt;
    final List<AssetRef> assets;
    ReleaseRef(String tag, boolean draft, boolean prerelease, long publishedAt, List<AssetRef> assets) { this(tag, draft, prerelease, false, publishedAt, assets); }
    ReleaseRef(String tag, boolean draft, boolean prerelease, boolean withdrawn, long publishedAt, List<AssetRef> assets) {
        this.tag = tag; this.draft = draft; this.prerelease = prerelease; this.withdrawn = withdrawn; this.publishedAt = publishedAt; this.assets = assets;
    }
    /** Mirrors scripts/fork-release-policy.ts: withdrawal rewrites only the notes, so the notes are the only signal. */
    private static final java.util.regex.Pattern WITHDRAWN = java.util.regex.Pattern.compile(
        "^<!-- t3-fork-release:withdrawn\\b[^>]*-->", java.util.regex.Pattern.MULTILINE);
    static boolean isWithdrawn(String body) { return body != null && WITHDRAWN.matcher(body).find(); }
    AssetRef asset(String name) {
        AssetRef found = null;
        for (AssetRef asset : assets) if (asset.name.equals(name)) {
            if (found != null) return null;
            found = asset;
        }
        return found;
    }
    static boolean validTag(String tag) { return tag != null && tag.matches("^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$"); }

    /** Releases with an unsafe tag or no publication time are skipped, never repaired. Newest first. */
    static List<ReleaseRef> parseList(String json) throws JSONException {
        JSONArray rows = new JSONArray(json);
        List<ReleaseRef> releases = new ArrayList<>();
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row == null) continue;
            String tag = row.optString("tag_name", "");
            String published = row.isNull("published_at") ? "" : row.optString("published_at", "");
            if (!validTag(tag) || published.isEmpty()) continue;
            long at;
            try { at = Iso8601.parse(published); } catch (IllegalArgumentException error) { continue; }
            List<AssetRef> assets = new ArrayList<>();
            JSONArray rawAssets = row.optJSONArray("assets");
            for (int j = 0; rawAssets != null && j < rawAssets.length(); j++) {
                JSONObject asset = rawAssets.optJSONObject(j);
                if (asset != null && asset.optString("name", "").length() > 0) assets.add(new AssetRef(asset.optString("name"), asset.optLong("size", -1)));
            }
            releases.add(new ReleaseRef(tag, row.optBoolean("draft", true), row.optBoolean("prerelease", false),
                isWithdrawn(row.isNull("body") ? "" : row.optString("body", "")), at, assets));
        }
        releases.sort((a, b) -> Long.compare(b.publishedAt, a.publishedAt));
        return releases;
    }
}
