/** Local browser protocol. Only the app bearer belongs in sessionStorage. */
import type { SourceGrantPolicy, Grant, AgentEnrollmentResult, SubjectLabel } from '@kizuki/core';
import type { ServeIntent, SupervisorKind, SupervisorState } from '@kizuki/core';
export interface AppServiceStatus {
    intent: ServeIntent | 'unknown';
    kind: SupervisorKind;
    state: SupervisorState;
    detail: string;
    checked_at: string;
}
export const APP_API_PREFIX = '/app/v1/';
export interface AppError {
    code: string;
    retryable: boolean;
}
export type AppResponse<T> = {
    ok: true;
    data: T;
} | {
    ok: false;
    error: AppError;
};
export interface AppSource {
    source_key: string;
    connector_id: string;
    display_name: string;
    state: string;
    consent: string;
    revision: number;
    required_fields: string[];
    last_run: string | null;
    stored: number;
    errors: number;
    revoke_operation: string | null;
    purge_blockers: string[];
    model_consent: 'local_only' | 'current' | 'different_model' | 'unavailable';
}
export type AppModelSelection = { kind: 'none' } | { kind: 'openai_compatible'; base_url: string; model: string };
export interface AppModelTest {
    revision: string;
    at: string;
    outcome: 'succeeded' | 'failed';
    latency_ms: number;
    error_code: string | null;
}
export interface AppModelStatus {
    revision: string;
    selection: { kind: 'none' } | { kind: 'openai_compatible'; base_url: string; model: string; model_endpoint: string };
    credential: 'none' | 'configured' | 'unavailable';
    last_test: AppModelTest | null;
}
export type AppModelCredential = { action: 'keep' | 'clear' } | { action: 'replace'; value: string };
export interface AppCatalogEntry {
    id: 'markdown' | 'gmail' | 'google-calendar';
    title: string;
    available: boolean;
    detail: string;
    fields: string[];
    required_fields: string[];
}
export interface AppOperation {
    id: string;
    kind: string;
    state: 'running' | 'succeeded' | 'failed' | 'unknown';
    stage: string;
    counts: {
        stored: number;
        duplicates: number;
        errors: number;
    } | null;
    result: {
        message: string;
        source_key?: string;
        receipt_id?: string;
        rewritten_pages?: number;
        recovery_pending?: { receipt_id: string; phase: 'write' | 'projection' }[];
        agent?: { receipt: AgentEnrollmentResult; mcp: { command: string; args: string[] } | null };
        run?: {
            run_id: string;
            status: string;
            canon_writes: number;
            claims_extracted: number;
            model_calls: number;
            model_configured: boolean;
        };
    } | null;
    error: AppError | null;
}
export interface AppHit {
    id: string;
    scope: 'canon' | 'ledger';
    title: string;
    text: string;
    citations: string[];
    sensitivity: string;
    taint?: 'clean' | 'quoted';
    subject_labels?: SubjectLabel[];
}
export interface AppReceipt {
    id: string;
    at: string;
    action: string;
    page: string;
    reverted: boolean;
}
export interface AppProtocol {
    status: {
        request: {};
        response: {
            vault: {
                ready: boolean;
                name: string;
            };
            setup_no_service: boolean;
            setup_supervisor: 'systemd' | 'launchd' | 'none';
            setup_location: string;
            visibility_epoch: string;
            operations: AppOperation[];
        };
    };
    catalog: {
        request: {};
        response: {
            sources: AppCatalogEntry[];
        };
    };
    initialize: {
        request: {
            path?: string;
            no_service?: boolean;
        };
        response: {
            operation_id: string;
        };
    };
    service_status: { request: {}; response: AppServiceStatus };
    install_service: { request: {}; response: { operation_id: string } };
    model_status: { request: {}; response: AppModelStatus };
    model_save: {
        request: { expected_revision: string; selection: AppModelSelection; credential: AppModelCredential };
        response: AppModelStatus;
    };
    model_test: { request: { expected_revision: string }; response: { operation_id: string } };
    source_model_consent: {
        request: { source_key: string; expected_revision: number; expected_model_revision: string; operation_id: string; allow: boolean };
        response: { source_key: string; revision: number; status: string };
    };
    run_pass: { request: {}; response: { operation_id: string } };
    agents: { request: {}; response: { agents: { agent_id: string; name: string; grant: Grant; revoked_at: string | null }[] } };
    agent_enroll: { request: { name: string; grant: Grant; operation_id: string }; response: { operation_id: string } };
    agent_revoke: { request: { name: string }; response: { operation_id: string } };
    correction_targets: { request: { page_id: string }; response: { claims: { claim_id: string; subject: string | null; predicate: string | null; object: string | null; body: string; authority: string; sensitivity: string }[]; truncated: boolean } };
    correction_preview: { request: { claim_id: string; statement: string; object?: string }; response: { answer: string; affected_pages: number | null } };
    correct: { request: { claim_id: string; statement: string; object?: string }; response: { operation_id: string } };
    sources: {
        request: {};
        response: {
            sources: AppSource[];
        };
    };
    enroll: {
        request: {
            provider: 'markdown' | 'gmail' | 'google-calendar';
            path?: string;
            fields?: string[];
            calendar_id?: string;
            source_key?: string;
            new_source?: boolean;
        };
        response: {
            operation_id: string;
        };
    };
    consent: {
        request: {
            source_key: string;
            expected_revision: number;
            operation_id: string;
            policy: SourceGrantPolicy;
        };
        response: {
            source_key: string;
            revision: number;
            status: string;
        };
    };
    revoke: {
        request: {
            source_key: string;
            expected_revision: number;
            operation_id: string;
        };
        response: {
            operation_id: string;
        };
    };
    resume_revocation: {
        request: {
            source_key: string;
            operation_id: string;
        };
        response: {
            operation_id: string;
        };
    };
    capture: {
        request: {
            source_key: string;
            mode: 'backfill' | 'sync';
        };
        response: {
            operation_id: string;
        };
    };
    query: {
        request: {
            text: string;
            limit?: number;
        };
        response: {
            hits: AppHit[];
            withheld: number;
            degraded: string[];
        };
    };
    activity: {
        request: {
            limit?: number;
        };
        response: {
            receipts: AppReceipt[];
        };
    };
    undo: {
        request: {
            receipt_id: string;
            cascade?: boolean;
        };
        response: {
            operation_id: string;
        };
    };
    operation: {
        request: {
            id: string;
        };
        response: AppOperation;
    };
}
export type AppRoute = keyof AppProtocol;
