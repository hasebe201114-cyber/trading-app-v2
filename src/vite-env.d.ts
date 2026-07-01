/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEPLOY_TIME: string;
  readonly VITE_APP_VERSION: string;
  readonly VITE_GIT_COMMIT: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
