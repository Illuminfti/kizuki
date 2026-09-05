/** Local browser protocol. Only the app bearer belongs in sessionStorage. */
import type { SourceGrantPolicy } from '@kizuki/core';
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
}
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
