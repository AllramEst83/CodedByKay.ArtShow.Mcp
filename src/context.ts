import type { DatabaseSync } from "node:sqlite";
import type { S3Client } from "@aws-sdk/client-s3";
import type { ResolvedConfig } from "./config.js";
import { createR2Client } from "./storage/r2.js";
import { ToolError } from "./lib/errors.js";

/** Passed to every tool handler. R2 client creation is lazy (only tools that touch R2 call
 * getR2Client()) so read-only/DB-only tools work even when credentials aren't configured. */
export class ServerContext {
  readonly config: ResolvedConfig;
  readonly db: DatabaseSync;
  private r2Client: S3Client | undefined;

  constructor(config: ResolvedConfig, db: DatabaseSync) {
    this.config = config;
    this.db = db;
  }

  getR2Client(): S3Client {
    if (!this.config.hasR2Credentials) {
      throw new ToolError(
        `R2 credentials not configured. Set them via dotnet user-secrets on ` +
          `CodedByKay.ArtShow.CLI (R2:AccessKeyId / R2:SecretAccessKey — same as the CLI itself ` +
          `reads), or set ARTSHOW_R2_ACCESS_KEY_ID / ARTSHOW_R2_SECRET_ACCESS_KEY for this server ` +
          `directly. Checked: user-secrets at ${this.config.userSecretsPath} ` +
          `(found: ${this.config.userSecretsFound}), appsettings.json at ${this.config.appSettingsPath} ` +
          `(found: ${this.config.appSettingsFound}).`,
      );
    }
    this.r2Client ??= createR2Client(this.config.r2);
    return this.r2Client;
  }
}
