/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_INKSHADOW_CLOUD_API_BASE_URL?: string;
  readonly VITE_INKSHADOW_CLOUD_ALLOW_INSECURE_LOOPBACK?: string;
  readonly VITE_INKSHADOW_CLOUD_IDENTITY_ENABLED?: string;
  readonly VITE_INKSHADOW_CLOUD_SYNC_ENABLED?: string;
  readonly VITE_INKSHADOW_TEAM_COLLABORATION_ENABLED?: string;
  readonly VITE_INKSHADOW_GRAPH_RAG_ENABLED?: string;
  readonly VITE_INKSHADOW_AUTHORITATIVE_EXTRACTION_ENABLED?: string;
  readonly VITE_INKSHADOW_MULTI_AGENT_ENABLED?: string;
  readonly VITE_INKSHADOW_FINE_TUNING_ENABLED?: string;
  readonly VITE_INKSHADOW_COMMUNITY_MARKETPLACE_ENABLED?: string;
  readonly VITE_INKSHADOW_TRANSLATION_ENABLED?: string;
  readonly VITE_INKSHADOW_SHORT_DRAMA_ENABLED?: string;
  readonly VITE_INKSHADOW_QA_WEBVIEW_STRESS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
