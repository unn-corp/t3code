import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export class TeamServiceConfigurationError extends Schema.TaggedError<TeamServiceConfigurationError>()(
  "TeamServiceConfigurationError",
  { message: Schema.String },
) {}

const ClerkSecret = Schema.String.check(Schema.isPattern(/^sk_(test|live)_\S+$/));
const ClerkPublishable = Schema.String.check(
  Schema.isPattern(/^pk_(test|live)_[A-Za-z0-9+/]+=*$/),
  Schema.makeFilter((value) => {
    try {
      // Clerk encodes its frontend API hostname followed by "$" in this key.
      return /^[A-Za-z0-9.-]+\.[A-Za-z0-9-]+\$$/.test(atob(value.slice(8)));
    } catch {
      return false;
    }
  }),
);

const validOrigin = (value: string) => {
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.origin === value &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  } catch {
    return false;
  }
};

const isClerkSecret = Schema.is(ClerkSecret);
const isClerkPublishable = Schema.is(ClerkPublishable);

// Errors name only the invalid settings, never the supplied credentials or URLs.
export const requireTeamServiceConfiguration = Effect.gen(function* () {
  const secret = yield* Config.redacted("T3_TEAM_CLERK_SECRET_KEY").pipe(
    Config.withDefault(Redacted.make("")),
  );
  const publishable = yield* Config.string("T3_TEAM_CLERK_PUBLISHABLE_KEY").pipe(
    Config.withDefault(""),
  );
  const origins = yield* Config.string("T3_TEAM_ORIGINS").pipe(Config.withDefault(""));
  const issuer = yield* Config.string("T3_TEAM_OAUTH_ISSUER").pipe(Config.withDefault(""));
  const client = yield* Config.string("T3_TEAM_OAUTH_CLIENT_ID").pipe(Config.withDefault(""));
  const secretValue = Redacted.value(secret);
  const invalid: string[] = [];
  const secretValid = isClerkSecret(secretValue);
  const publishableValid = isClerkPublishable(publishable);
  if (!secretValid) invalid.push("T3_TEAM_CLERK_SECRET_KEY");
  if (!publishableValid || (secretValid && publishable.slice(3, 7) !== secretValue.slice(3, 7)))
    invalid.push("T3_TEAM_CLERK_PUBLISHABLE_KEY");
  const entries = origins.split(",");
  if (!entries.length || entries.some((entry) => !validOrigin(entry)))
    invalid.push("T3_TEAM_ORIGINS");
  if (
    Boolean(issuer) !== Boolean(client) ||
    (issuer && !validOrigin(issuer)) ||
    (client && (!client.trim() || /\s/.test(client)))
  )
    invalid.push("T3_TEAM_OAUTH_ISSUER/T3_TEAM_OAUTH_CLIENT_ID");
  if (invalid.length)
    return yield* new TeamServiceConfigurationError({
      message: `Teams collaboration service requires valid configuration: ${invalid.join(", ")}.`,
    });
});
