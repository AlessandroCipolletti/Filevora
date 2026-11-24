export const DESCRIPTION_KEY_MESSAGE =
  'A description cannot be created without a Gemini API key. Set FILEVORA_GEMINI_API_KEY to a key from Google AI Studio. Descriptions stay off until that variable is set.';

export const DESCRIPTION_DATABASE_MESSAGE =
  'Descriptions are stored in the database so queries over assets stay fast. Lite mode keeps only asset cards and cannot store them. Set FILEVORA_DATABASE_URL to postgres:// or postgresql://, mysql:// or mariadb://, or sqlite://./filevora.sqlite, then run npx filevora migrate.';
