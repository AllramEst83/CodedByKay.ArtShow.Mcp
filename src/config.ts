import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// Defaults match CodedByKay.ArtShow.CLI/appsettings.json and Options/*.cs — see
// ArtShow.Workspace/AGENTS.md "Known local paths". Overridable per-field via env vars below, so
// this server works on a machine laid out differently without editing source.
const DEFAULT_CLI_ROOT = String.raw`C:\Users\kaywi\dev\CodedByKay.ArtShow.CLI`;
const DEFAULT_SITE_REPO_PATH = String.raw`C:\Users\kaywi\dev\CodedByKay.ArtShow`;
const DEFAULT_R2_PUBLIC_BASE_URL = "https://kaysartshow.fyi";
// Where Kay drops new drawings before adding them — see ArtShow.Workspace/working-on. Only used
// as the default `folder` argument for the add-new-drawings prompt; add_artworks itself takes
// explicit file paths and never scans a directory on its own.
const DEFAULT_STAGING_FOLDER = String.raw`C:\Users\kaywi\dev\Workspaces\ArtShow.Workspace\new drawings`;
const DOTNET_USER_SECRETS_ID = "codedbykay-artshow-cli"; // CodedByKay.ArtShow.CLI.csproj <UserSecretsId>

export type CredentialSource = "env" | "user-secrets" | "appsettings" | "missing";

export interface R2Config {
  accountId: string;
  bucket: string;
  publicBaseUrl: string;
  accessKeyId: string;
  secretAccessKey: string;
  serviceUrl: string;
  accessKeyIdSource: CredentialSource;
  secretAccessKeySource: CredentialSource;
}

export interface ResolvedConfig {
  cliRoot: string;
  dbPath: string;
  dbPathSource: "env" | "default";
  siteRepoPath: string;
  siteArtworkJsonPath: string;
  stagingFolderPath: string;
  r2: R2Config;
  hasR2Credentials: boolean;
  appSettingsPath: string;
  appSettingsFound: boolean;
  userSecretsPath: string;
  userSecretsFound: boolean;
}

interface AppSettingsShape {
  Catalog?: { DbPath?: string };
  Publish?: { SiteRepoPath?: string };
  R2?: {
    Bucket?: string;
    PublicBaseUrl?: string;
    AccountId?: string;
    AccessKeyId?: string;
    SecretAccessKey?: string;
  };
}

interface UserSecretsShape {
  "R2:AccessKeyId"?: string;
  "R2:SecretAccessKey"?: string;
}

/** dotnet's Microsoft.Extensions.Configuration.Json writes secrets.json with a UTF-8 BOM; plain
 * JSON.parse rejects that ("Unexpected UTF-8 BOM") — strip it before parsing. Same treatment for
 * appsettings.json defensively, since it's hand-edited and could pick one up too. */
function readJsonFileBomSafe<T>(filePath: string): T | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    const raw = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(raw) as T;
  } catch (err) {
    console.error(`artshow-mcp: failed to parse ${filePath}: ${(err as Error).message}`);
    return undefined;
  }
}

function nonEmpty(value: string | undefined | null): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}

function userSecretsPath(): string {
  const appData = process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming");
  return path.join(appData, "Microsoft", "UserSecrets", DOTNET_USER_SECRETS_ID, "secrets.json");
}

export function loadConfig(): ResolvedConfig {
  const cliRoot = nonEmpty(process.env.ARTSHOW_CLI_ROOT) ?? DEFAULT_CLI_ROOT;
  const appSettingsPath = path.join(cliRoot, "appsettings.json");
  const appSettings = readJsonFileBomSafe<AppSettingsShape>(appSettingsPath);

  const secretsPath = userSecretsPath();
  const userSecrets = readJsonFileBomSafe<UserSecretsShape>(secretsPath);

  // dbPath: env override > appsettings Catalog:DbPath (resolved against cliRoot) > CLI's own default.
  let dbPath: string;
  let dbPathSource: "env" | "default" = "default";
  if (nonEmpty(process.env.ARTSHOW_DB_PATH)) {
    dbPath = process.env.ARTSHOW_DB_PATH!;
    dbPathSource = "env";
  } else {
    const relative = appSettings?.Catalog?.DbPath ?? String.raw`Db\artwork.db`;
    dbPath = path.isAbsolute(relative) ? relative : path.resolve(cliRoot, relative);
  }

  const siteRepoPath =
    nonEmpty(process.env.ARTSHOW_SITE_REPO_PATH) ?? appSettings?.Publish?.SiteRepoPath ?? DEFAULT_SITE_REPO_PATH;

  const bucket = nonEmpty(process.env.ARTSHOW_R2_BUCKET) ?? appSettings?.R2?.Bucket ?? "";
  const accountId = nonEmpty(process.env.ARTSHOW_R2_ACCOUNT_ID) ?? appSettings?.R2?.AccountId ?? "";
  const publicBaseUrl =
    nonEmpty(process.env.ARTSHOW_R2_PUBLIC_BASE_URL) ??
    appSettings?.R2?.PublicBaseUrl ??
    DEFAULT_R2_PUBLIC_BASE_URL;

  const [accessKeyId, accessKeyIdSource] = resolveCredential(
    process.env.ARTSHOW_R2_ACCESS_KEY_ID,
    userSecrets?.["R2:AccessKeyId"],
    appSettings?.R2?.AccessKeyId,
  );
  const [secretAccessKey, secretAccessKeySource] = resolveCredential(
    process.env.ARTSHOW_R2_SECRET_ACCESS_KEY,
    userSecrets?.["R2:SecretAccessKey"],
    appSettings?.R2?.SecretAccessKey,
  );

  const r2: R2Config = {
    accountId,
    bucket,
    publicBaseUrl: publicBaseUrl.replace(/\/+$/, ""),
    accessKeyId,
    secretAccessKey,
    serviceUrl: `https://${accountId}.r2.cloudflarestorage.com`,
    accessKeyIdSource,
    secretAccessKeySource,
  };

  return {
    cliRoot,
    dbPath,
    dbPathSource,
    siteRepoPath,
    siteArtworkJsonPath: path.join(siteRepoPath, "data", "artwork.json"),
    stagingFolderPath: nonEmpty(process.env.ARTSHOW_STAGING_FOLDER) ?? DEFAULT_STAGING_FOLDER,
    r2,
    hasR2Credentials: accessKeyId.length > 0 && secretAccessKey.length > 0,
    appSettingsPath,
    appSettingsFound: appSettings !== undefined,
    userSecretsPath: secretsPath,
    userSecretsFound: userSecrets !== undefined,
  };
}

// Precedence matches Program.cs's ConfigurationBuilder (AddJsonFile, then AddUserSecrets, then
// AddEnvironmentVariables — later sources win): env var overrides user-secrets overrides
// appsettings.json.
function resolveCredential(
  envValue: string | undefined,
  userSecretValue: string | undefined,
  appSettingsValue: string | undefined,
): [string, CredentialSource] {
  if (nonEmpty(envValue)) return [envValue!, "env"];
  if (nonEmpty(userSecretValue)) return [userSecretValue!, "user-secrets"];
  if (nonEmpty(appSettingsValue)) return [appSettingsValue!, "appsettings"];
  return ["", "missing"];
}
