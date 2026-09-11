// Mirrors CodedByKay.ArtShow.CLI/Data/Artwork.cs — keep in sync if that model changes.
export interface ArtworkRow {
  Id: number;
  AddedDate: string;
  Title: string;
  Description: string | null;
  CreatedDate: string | null;
  Category: string | null;
  Medium: string | null;
  Type: string | null; // null = image, "video" = video
  OriginalPath: string;
  R2Key: string | null;
  ThumbR2Key: string | null;
  VideoId: string | null;
  Tags: string; // JSON string array
  Groups: string; // JSON string array
}

export interface ArtworkDto {
  id: number;
  type: "image" | "video";
  addedDate: string;
  title: string;
  description: string | null;
  createdDate: string | null;
  category: string | null;
  medium: string | null;
  tags: string[];
  groups: string[];
  r2Key: string | null;
  thumbR2Key: string | null;
  videoId: string | null;
  originalPath: string;
  // Convenience URLs, built the same way CodedByKay.ArtShow.CLI/Publishing/ArtworkJsonWriter.cs
  // builds them for the site's data/artwork.json — see ArtShow.Workspace/AGENTS.md.
  imageUrl: string | null;
  thumbnailUrl: string | null;
  videoUrl: string | null;
}

export interface ClassifierRow {
  Id: number;
  Kind: string;
  Name: string;
}

export interface PublishStateRow {
  Id: number;
  Dirty: number;
}
