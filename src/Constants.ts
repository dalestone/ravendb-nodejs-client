import { MetadataObject } from "./Documents/Session/MetadataObject";

export const CONSTANTS = {
    Documents: {
        Indexing: {
            Fields: {
                ALL_FIELDS: "__all_fields",
                DOCUMENT_ID_FIELD_NAME: "id()",
                REDUCE_KEY_HASH_FIELD_NAME: "hash(key())",
                REDUCE_KEY_KEY_VALUE_FIELD_NAME: "key()",
                SPATIAL_SHAPE_FIELD_NAME: "spatial(shape)",
                // TBD 4.1 CUSTOM_SORT_FIELD_NAME: "__customSort",
            },
            Spatial: {
                DEFAULT_DISTANCE_ERROR_PCT: 0.025,
            },
            SIDE_BY_SIDE_INDEX_NAME_PREFIX: "ReplacementOf/",
        },
        Metadata: {
            COLLECTION: "@collection" as keyof MetadataObject,
            PROJECTION: "@projection" as keyof MetadataObject,
            KEY: "@metadata" as keyof MetadataObject,
            ID: "@id" as keyof MetadataObject,
            CONFLICT: "@conflict",
            ID_PROPERTY: "id",
            FLAGS: "@flags" as keyof MetadataObject,
            ATTACHMENTS: "@attachments" as keyof MetadataObject,
            INDEX_SCORE: "@index-score" as keyof MetadataObject,
            LAST_MODIFIED: "@last-modified" as keyof MetadataObject,
            RAVEN_JS_TYPE: "Raven-Node-Type" as keyof MetadataObject,
            CHANGE_VECTOR: "@change-vector" as keyof MetadataObject,
            EXPIRES: "@expires" as keyof MetadataObject,
            ALL_DOCUMENTS_COLLECTION: "@all_docs",
            EMPTY_COLLECTION: "@empty",
            NESTED_OBJECT_TYPES: "@nested-object-types" as keyof MetadataObject,
            COUNTERS: "@counters" as keyof MetadataObject,
            REVISION_COUNTERS: "@counters-snapshot",
            IGNORE_CASE_TRANSFORM_REGEX:
            // tslint:disable-next-line:max-line-length
                /^@metadata(\.(@collection|@projection|@id|@conflict|@flags|Raven-Node-Type|@index-score|@last-modified|@change-vector|@expires|@nested-object-types(\.\w+)?))?$/
        },
    }
};

export const HEADERS = {
    REQUEST_TIME: "Raven-Request-Time",
    REFRESH_TOPOLOGY: "Refresh-Topology",
    TOPOLOGY_ETAG: "Topology-Etag",
    LAST_KNOWN_CLUSTER_TRANSACTION_INDEX: "Known-Raft-Index",
    CLIENT_CONFIGURATION_ETAG: "Client-Configuration-Etag",
    REFRESH_CLIENT_CONFIGURATION: "Refresh-Client-Configuration",
    CLIENT_VERSION: "Raven-Client-Version",
    SERVER_VERSION: "Raven-Server-Version",
    ETAG: "ETag",
    IF_NONE_MATCH: "If-None-Match",
    TRANSFER_ENCODING: "Transfer-Encoding",
    CONTENT_ENCODING: "Content-Encoding",
    CONTENT_LENGTH: "Content-Length",
    DATABASE_MISSING: "Database-Missing"
};

export const COUNTERS = {
    ALL: "@all_counters"
};
