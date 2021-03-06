import * as BluebirdPromise from "bluebird";
import { EntityToJson } from "./EntityToJson";
import { IDisposable } from "../../Types/Contracts";
import { SessionInfo, ConcurrencyCheckMode, StoreOptions } from "./IDocumentSession";
import { IMetadataDictionary } from "./IMetadataDictionary";
import { ObjectTypeDescriptor, ClassConstructor } from "../../Types";
import { SessionEventsEmitter, SessionBeforeStoreEventArgs, SessionBeforeDeleteEventArgs } from "./SessionEvents";
import { RequestExecutor } from "../../Http/RequestExecutor";
import { IDocumentStore } from "../IDocumentStore";
import CurrentIndexAndNode from "../../Http/CurrentIndexAndNode";
import { throwError, getError } from "../../Exceptions";
import { ServerNode } from "../../Http/ServerNode";
import { DocumentsById } from "./DocumentsById";
import { DocumentInfo } from "./DocumentInfo";
import { DocumentStoreBase } from "../DocumentStoreBase";
import {
    ICommandData,
    DeleteCommandData,
    SaveChangesData,
    PutCommandDataWithJson,
    CommandType
} from "../Commands/CommandData";
import { PutCompareExchangeCommandData } from "../Commands/Batches/PutCompareExchangeCommandData";
import { DeleteCompareExchangeCommandData } from "../Commands/Batches/DeleteCompareExchangeCommandData";
import { BatchPatchCommandData } from "../Commands/Batches/BatchPatchCommandData";
import { GenerateEntityIdOnTheClient } from "../Identity/GenerateEntityIdOnTheClient";
import { tryGetConflict } from "../../Mapping/Json";
import { CONSTANTS } from "../../Constants";
import { DateUtil } from "../../Utility/DateUtil";
import { ObjectUtil } from "../../Utility/ObjectUtil";
import { IncludesUtil } from "./IncludesUtil";
import { TypeUtil } from "../../Utility/TypeUtil";
import { ErrorFirstCallback } from "../../Types/Callbacks";
import { DocumentType } from "../DocumentAbstractions";
import { IdTypeAndName } from "../IdTypeAndName";
import { BatchOptions } from "../Commands/Batches/BatchOptions";
import { DocumentsChanges } from "./DocumentsChanges";
import { EventEmitter } from "events";
import { JsonOperation } from "../../Mapping/JsonOperation";
import { IRavenObject } from "../../Types/IRavenObject";
import { GetDocumentsResult } from "../Commands/GetDocumentsCommand";
import { DocumentConventions } from "../Conventions/DocumentConventions";
import { RavenCommand } from "../../Http/RavenCommand";
import { JsonSerializer } from "../../Mapping/Json/Serializer";
import { OperationExecutor } from "../Operations/OperationExecutor";
import { createMetadataDictionary } from "../../Mapping/MetadataAsDictionary";
import { IndexBatchOptions, ReplicationBatchOptions } from "./IAdvancedSessionOperations";
import { ILazyOperation } from "./Operations/Lazy/ILazyOperation";
import { TransactionMode } from "./TransactionMode";
import { CounterTracking } from "./CounterInternalTypes";
import { CaseInsensitiveKeysMap } from "../../Primitives/CaseInsensitiveKeysMap";
import { CaseInsensitiveStringSet } from "../../Primitives/CaseInsensitiveStringSet";
import { DocumentStore } from "../DocumentStore";
import { SessionOptions } from "./SessionOptions";
import { ClusterTransactionOperationsBase } from "./ClusterTransactionOperationsBase";
import { BatchCommandResult } from "./Operations/BatchCommandResult";
import { SessionOperationExecutor } from "../Operations/SessionOperationExecutor";
import { StringUtil } from "../../Utility/StringUtil";

export abstract class InMemoryDocumentSessionOperations
    extends EventEmitter
    implements IDisposable, SessionEventsEmitter {

    private static _clientSessionIdCounter: number = 0;

    protected _clientSessionId: number = ++InMemoryDocumentSessionOperations._clientSessionIdCounter;

    protected _requestExecutor: RequestExecutor;

    private _operationExecutor: OperationExecutor;

    protected _pendingLazyOperations: ILazyOperation[] = [];

    protected static _instancesCounter: number = 0;

    private _hash = ++InMemoryDocumentSessionOperations._instancesCounter;

    private _disposed: boolean;

    protected _jsonSerializer: JsonSerializer = JsonSerializer.getDefaultForCommandPayload();

    private readonly _id: string;

    public get id() {
        return this._id;
    }

    public deletedEntities: Set<object> = new Set();

    protected _knownMissingIds: Set<string> = CaseInsensitiveStringSet.create();

    private _externalState: Map<string, object>;

    private _transactionMode: TransactionMode;

    public get externalState() {
        if (!this._externalState) {
            this._externalState = new Map();
        }

        return this._externalState;
    }

    public getCurrentSessionNode(): Promise<ServerNode> {
        let result: Promise<CurrentIndexAndNode>;
        switch (this._documentStore.conventions.readBalanceBehavior) {
            case "None":
                result = this._requestExecutor.getPreferredNode();
                break;
            case "RoundRobin":
                result = this._requestExecutor.getNodeBySessionId(this._clientSessionId);
                break;
            case "FastestNode":
                result = this._requestExecutor.getFastestNode();
                break;
            default:
                return Promise.reject(
                    getError("InvalidArgumentException", this._documentStore.conventions.readBalanceBehavior));
        }

        return result.then(x => x.currentNode);
    }

    public documentsById: DocumentsById = new DocumentsById();

    /**
     * map holding the data required to manage Counters tracking for RavenDB's Unit of Work
     */
    public get countersByDocId(): Map<string, CounterTracking> {
        if (!this._countersByDocId) {
            this._countersByDocId = CaseInsensitiveKeysMap.create();
        }

        return this._countersByDocId;
    }

    private _countersByDocId: Map<string, CounterTracking>;

    public readonly noTracking: boolean;

    public includedDocumentsById: Map<string, DocumentInfo> = CaseInsensitiveKeysMap.create();

    public documentsByEntity: Map<object, DocumentInfo> = new Map();

    protected _documentStore: DocumentStoreBase;

    private readonly _databaseName: string;

    private _saveChangesOptions: BatchOptions;

    public get databaseName(): string {
        return this._databaseName;
    }

    public get documentStore(): IDocumentStore {
        return this._documentStore;
    }

    public get requestExecutor(): RequestExecutor {
        return this._requestExecutor;
    }

    public get operations() {
        if (!this._operationExecutor) {
            this._operationExecutor = new SessionOperationExecutor(this);
        }

        return this._operationExecutor;
    }

    private _numberOfRequests: number = 0;

    public get numberOfRequests() {
        return this._numberOfRequests;
    }

    public getNumberOfEntitiesInUnitOfWork() {
        return this.documentsByEntity.size;
    }

    public get storeIdentifier(): string {
        return `${this._documentStore.identifier};${this._databaseName}`;
    }

    public get conventions(): DocumentConventions {
        return this._requestExecutor.conventions;
    }

    public maxNumberOfRequestsPerSession: number;

    public useOptimisticConcurrency: boolean;

    protected _deferredCommands: ICommandData[] = [];

    // keys are produced with CommandIdTypeAndName.keyFor() method
    public deferredCommandsMap: Map<string, ICommandData> = new Map();

    public get deferredCommandsCount() {
        return this._deferredCommands.length;
    }

    private readonly _generateEntityIdOnTheClient: GenerateEntityIdOnTheClient;

    public get generateEntityIdOnTheClient() {
        return this._generateEntityIdOnTheClient;
    }

    private readonly _entityToJson: EntityToJson;

    public get entityToJson() {
        return this._entityToJson;
    }

    protected _sessionInfo: SessionInfo;

    public get sessionInfo() {
        return this._sessionInfo;
    }

    protected constructor(
        documentStore: DocumentStore,
        id: string,
        options: SessionOptions) {
        super();

        this._id = id;
        this._databaseName = options.database || documentStore.database;

        if (StringUtil.isNullOrWhitespace(this._databaseName)) {
            InMemoryDocumentSessionOperations._throwNoDatabase();
        }

        this._documentStore = documentStore;
        this._requestExecutor = 
            options.requestExecutor || documentStore.getRequestExecutor(this._databaseName);

        this.noTracking = options.noTracking;

        this.useOptimisticConcurrency = this._requestExecutor.conventions.isUseOptimisticConcurrency();
        this.maxNumberOfRequestsPerSession = this._requestExecutor.conventions.maxNumberOfRequestsPerSession;
        this._generateEntityIdOnTheClient =
            new GenerateEntityIdOnTheClient(this._requestExecutor.conventions,
                (obj) => this._generateId(obj));
        this._entityToJson = new EntityToJson(this);

        this._sessionInfo = new SessionInfo(
            this._clientSessionId,
            this._documentStore.getLastTransactionIndex(this.databaseName), 
            options.noCaching);
        this._transactionMode = options.transactionMode;
    }

    protected abstract _generateId(entity: object): Promise<string>;

    /**
     * Gets the metadata for the specified entity.
     */
    public getMetadataFor<T extends object>(instance: T): IMetadataDictionary {
        if (!instance) {
            throwError("InvalidOperationException", "Instance cannot be null or undefined.");
        }

        const documentInfo = this._getDocumentInfo(instance);
        return this._makeMetadataInstance(documentInfo);
    }

    /**
     * Gets all counter names for the specified entity.
     */
    public getCountersFor<T extends object>(instance: T): string[] {
        if (!instance) {
            throwError("InvalidArgumentException", "Instance cannot be null.");
        }

        const documentInfo = this._getDocumentInfo(instance);
        const countersArray = documentInfo.metadata[CONSTANTS.Documents.Metadata.COUNTERS] as string[];
        if (!countersArray) {
            return null;
        }

        return countersArray;
    }

    private _makeMetadataInstance<T extends object>(docInfo: DocumentInfo): IMetadataDictionary {
        const metadataInstance = docInfo.metadataInstance;
        if (metadataInstance) {
            return metadataInstance;
        }

        const metadataAsJson = docInfo.metadata;
        const metadata = createMetadataDictionary({ raw: metadataAsJson });
        docInfo.entity[CONSTANTS.Documents.Metadata.KEY] = docInfo.metadataInstance = metadata;

        return metadata;
    }

    private _getDocumentInfo<T extends object>(instance: T): DocumentInfo {
        const documentInfo: DocumentInfo = this.documentsByEntity.get(instance);

        if (documentInfo) {
            return documentInfo;
        }

        let idRef;
        if (!this._generateEntityIdOnTheClient.tryGetIdFromInstance(
            instance, (_idRef) => idRef = _idRef)) {
            throwError("InvalidOperationException", "Could not find the document id for " + instance);
        }

        this._assertNoNonUniqueInstance(instance, idRef);

        throwError("InvalidArgumentException", "Document " + idRef + " doesn't exist in the session");
    }

    protected _assertNoNonUniqueInstance(entity: object, id: string): void {
        if (!id
            || id[id.length - 1] === "|"
            || id[id.length - 1] === "/") {
            return;
        }

        const info: DocumentInfo = this.documentsById.getValue(id);
        if (!info || info.entity === entity) {
            return;
        }

        throwError("NonUniqueObjectException", "Attempted to associate a different object with id '" + id + "'.");
    }

    /**
     * Gets the Change Vector for the specified entity.
     * If the entity is transient, it will load the change vector from the store
     * and associate the current state of the entity with the change vector from the server.
     */
    public getChangeVectorFor<T extends object>(instance: T): string {
        if (!instance) {
            throwError("InvalidArgumentException", "Instance cannot be null or undefined.");
        }

        const documentInfo: DocumentInfo = this._getDocumentInfo(instance);
        const changeVector = documentInfo.metadata[CONSTANTS.Documents.Metadata.CHANGE_VECTOR];
        if (changeVector) {
            return changeVector.toString() as string;
        }

        return null;
    }

    public getLastModifiedFor<T extends object>(instance: T): Date {
        if (!instance) {
            throwError("InvalidArgumentException", "Instance cannot be null or undefined.");
        }

        const documentInfo = this._getDocumentInfo(instance);
        const lastModified = documentInfo.metadata["@last-modified"];
        return DateUtil.default.parse(lastModified);
    }

    /**
     * Returns whether a document with the specified id is loaded in the
     * current session
     */
    public isLoaded(id: string): boolean {
        return this.isLoadedOrDeleted(id);
    }

    public isLoadedOrDeleted(id: string): boolean {
        const documentInfo = this.documentsById.getValue(id);
        return !!(documentInfo && (documentInfo.document || documentInfo.entity))
            || this.isDeleted(id)
            || this.includedDocumentsById.has(id);
    }

    /**
     * Returns whether a document with the specified id is deleted
     * or known to be missing
     */
    public isDeleted(id: string): boolean {
        return this._knownMissingIds.has(id);
    }

    /**
     * Gets the document id.
     */
    public getDocumentId(instance: object): string {
        if (!instance) {
            return null;
        }

        const value = this.documentsByEntity.get(instance);
        return value ? value.id : null;
    }

    public incrementRequestCount(): void {
        if (++this._numberOfRequests > this.maxNumberOfRequestsPerSession) {
            throwError("InvalidOperationException",
                // tslint:disable:max-line-length
                `The maximum number of requests (${this.maxNumberOfRequestsPerSession}) allowed for this session has been reached.` +
                "Raven limits the number of remote calls that a session is allowed to make as an early warning system. Sessions are expected to be short lived, and " +
                "Raven provides facilities like load(string[] keys) to load multiple documents at once and batch saves (call SaveChanges() only once)." +
                "You can increase the limit by setting DocumentConvention.MaxNumberOfRequestsPerSession or MaxNumberOfRequestsPerSession, but it is" +
                "advisable that you'll look into reducing the number of remote calls first, since that will speed up your application significantly and result in a" +
                // tslint:enable:max-line-length
                "more responsive application.");
        }
    }

    public checkIfIdAlreadyIncluded(ids: string[], includes: { [key: string]: ObjectTypeDescriptor }): boolean;
    public checkIfIdAlreadyIncluded(ids: string[], includes: string[]): boolean;
    public checkIfIdAlreadyIncluded(
        ids: string[], includes: string[] | { [key: string]: ObjectTypeDescriptor }): boolean {

        if (!Array.isArray(includes) && typeof includes === "object") {
            return this.checkIfIdAlreadyIncluded(ids, Object.keys(includes));
        }

        for (const id of ids) {
            if (this._knownMissingIds.has(id)) {
                continue;
            }

            // Check if document was already loaded, the check if we've received it through include
            let documentInfo: DocumentInfo = this.documentsById.getValue(id);
            if (!documentInfo) {
                documentInfo = this.includedDocumentsById.get(id);
                if (!documentInfo) {
                    return false;
                }
            }

            if (!documentInfo.entity) {
                return false;
            }

            if (!includes) {
                continue;
            }

            for (const include of includes) {
                let hasAll: boolean = true;

                IncludesUtil.include(documentInfo.document, include, (includeId: string) => {
                    hasAll = hasAll && this.isLoaded(includeId);
                });

                if (!hasAll[0]) {
                    return false;
                }
            }
        }

        return true;
    }

    /**
     * Tracks the entity inside the unit of work
     */
    public trackEntity<T extends object>(
        entityType: ObjectTypeDescriptor<T>, documentFound: DocumentInfo): T;
    public trackEntity<T extends object>(
        entityType: ObjectTypeDescriptor<T>,
        id: string,
        document: object,
        metadata: object,
        noTracking: boolean): object;
    public trackEntity<T extends object>(
        entityType: ObjectTypeDescriptor<T>,
        idOrDocumentInfo: string | DocumentInfo,
        document?: object,
        metadata?: object,
        noTracking?: boolean): T {

        let id: string;
        if (TypeUtil.isObject(idOrDocumentInfo)) {
            const info = idOrDocumentInfo as DocumentInfo;
            return this.trackEntity(entityType, info.id, info.document, info.metadata, this.noTracking) as T;
        } else {
            id = idOrDocumentInfo as string;
        }

        // if noTracking is session-wide then we want to override the passed argument
        noTracking = this.noTracking || noTracking;  

        if (!id) {
            return this._deserializeFromTransformer(entityType, null, document) as T;
        }

        let docInfo: DocumentInfo = this.documentsById.getValue(id);
        if (docInfo) {
            // the local instance may have been changed, we adhere to the current Unit of Work
            // instance, and return that, ignoring anything new.

            if (!docInfo.entity) {
                docInfo.entity = this.entityToJson.convertToEntity(entityType, id, document);
                this._makeMetadataInstance(docInfo);
            }

            if (!noTracking) {
                this.includedDocumentsById.delete(id);
                this.documentsByEntity.set(docInfo.entity, docInfo);
            }

            return docInfo.entity as T;
        }

        docInfo = this.includedDocumentsById.get(id);
        if (docInfo) {
            if (!docInfo.entity) {
                docInfo.entity = this.entityToJson.convertToEntity(entityType, id, document);
                this._makeMetadataInstance(docInfo);
            }

            if (!noTracking) {
                this.includedDocumentsById.delete(id);
                this.documentsById.add(docInfo);
                this.documentsByEntity.set(docInfo.entity, docInfo);
            }

            return docInfo.entity as T;
        }

        const entity = this.entityToJson.convertToEntity(entityType, id, document);

        const changeVector = metadata[CONSTANTS.Documents.Metadata.CHANGE_VECTOR];
        if (!changeVector) {
            throwError("InvalidOperationException", "Document " + id + " must have Change Vector.");
        }

        if (!noTracking) {
            const newDocumentInfo: DocumentInfo = new DocumentInfo();
            newDocumentInfo.id = id;
            newDocumentInfo.document = document;
            newDocumentInfo.metadata = metadata;
            newDocumentInfo.entity = entity;
            newDocumentInfo.changeVector = changeVector;

            this.documentsById.add(newDocumentInfo);
            this.documentsByEntity.set(entity, newDocumentInfo);
            this._makeMetadataInstance(newDocumentInfo);
        }

        return entity as T;
    }

    public registerExternalLoadedIntoTheSession(info: DocumentInfo): void {
        if (this.noTracking) {
            return;
        }
        
        const existing = this.documentsById.getValue(info.id);
        if (existing) {
            if (existing.entity === info.entity) {
                return;
            }

            throwError(
                "InvalidOperationException", 
                "The document " + info.id + " is already in the session with a different entity instance.");
        }
        
        const existingEntity = this.documentsByEntity.get(info.entity);
        if (existingEntity) {
            if (StringUtil.equalsIgnoreCase(existingEntity.id, info.id)) {
                return;
            }
            
            throwError(
                "InvalidOperationException", 
                "Attempted to load an entity with id " 
                + info.id 
                + ", but the entity instance already exists in the session with id: " + existing.id);
        }
        
        this.documentsByEntity.set(info.entity, info);
        this.documentsById.add(info);
        this.includedDocumentsById.delete(info.id);
     }

    private _deserializeFromTransformer(clazz: ObjectTypeDescriptor, id: string, document: object): object {
        return this.entityToJson.convertToEntity(clazz, id, document);
    }

    public registerIncludes(includes: object): void {
        if (this.noTracking) {
            return;
        }

        if (!includes) {
            return;
        }

        for (const fieldName of Object.keys(includes)) {
            const fieldValue = includes[fieldName];

            if (TypeUtil.isNullOrUndefined(fieldValue)) {
                continue;
            }

            const newDocumentInfo = DocumentInfo.getNewDocumentInfo(fieldValue);
            if (tryGetConflict(newDocumentInfo.metadata)) {
                continue;
            }

            this.includedDocumentsById.set(newDocumentInfo.id, newDocumentInfo);
        }
    }

    public registerMissingIncludes(results: object[], includes: object, includePaths: string[]): void {
        if (this.noTracking) {
            return;
        }

        if (!includePaths || !includePaths.length) {
            return;
        }

        for (const result of results) {
            for (const include of includePaths) {
                if (include === CONSTANTS.Documents.Indexing.Fields.DOCUMENT_ID_FIELD_NAME) {
                    continue;
                }

                IncludesUtil.include(result, include, id => {
                    if (!id) {
                        return;
                    }

                    if (this.isLoaded(id)) {
                        return;
                    }

                    const document = includes[id];
                    if (document) {
                        const metadata = document.get(CONSTANTS.Documents.Metadata.KEY);

                        if (tryGetConflict(metadata)) {
                            return;
                        }
                    }

                    this.registerMissing(id);
                });
            }
        }
    }

    public registerMissing(id: string): void {
        if (this.noTracking) {
            return;
        }

        this._knownMissingIds.add(id);
    }

    public unregisterMissing(id: string) {
        this._knownMissingIds.delete(id);
    }

    public registerCounters(
        resultCounters: object, 
        countersToInclude: { [key: string]: string[] }): void;
    public registerCounters(
        resultCounters: object, 
        ids: string[], 
        countersToInclude: string[], 
        gotAll: boolean): void;
    public registerCounters(
        resultCounters: object, 
        idsOrCountersToInclude: string[] | { [key: string]: string[] }, 
        countersToInclude?: string[],
        gotAll?: boolean) {
            if (Array.isArray(idsOrCountersToInclude)) {
                this._registerCountersWithIdsList(resultCounters, idsOrCountersToInclude, countersToInclude, gotAll);
            } else {
                this._registerCountersWithCountersToIncludeObj(resultCounters, idsOrCountersToInclude);
            }
        }

    private _registerCountersWithIdsList(
        resultCounters: object, 
        ids: string[], 
        countersToInclude: string[], 
        gotAll: boolean): void {
        if (this.noTracking) {
            return;
        }

        if (!resultCounters || Object.keys(resultCounters).length === 0) {
            if (gotAll) {
                for (const id of ids) {
                    this._setGotAllCountersForDocument(id);
                }
                return;
            }
        } else {
            this._registerCountersInternal(resultCounters, null, false, gotAll);
        }

        this._registerMissingCounters(ids, countersToInclude);
    }

    private _registerCountersWithCountersToIncludeObj(
        resultCounters: object, 
        countersToInclude: { [key: string]: string[] }): void {

        if (this.noTracking) {
            return;
        }

        if (!resultCounters || Object.keys(resultCounters).length === 0) {
            this._setGotAllInCacheIfNeeded(countersToInclude);
        } else {
            this._registerCountersInternal(resultCounters, countersToInclude, true, false);
        }

        this._registerMissingCounters(countersToInclude);
    }
     private _registerCountersInternal(
         resultCounters: object, 
         countersToInclude: { [key: string]: string[] }, 
         fromQueryResult: boolean, 
         gotAll: boolean): void {
         for (const [field, value] of Object.entries(resultCounters)) {
             if (!value) {
                 continue;
             }

             if (fromQueryResult) {
                 const counters = countersToInclude[field];
                 gotAll = counters && counters.length === 0;
             }

             if (value.length === 0 && !gotAll) {
                 continue;
             }

             this._registerCountersForDocument(field, gotAll, value);
         }
    }

    private _registerCountersForDocument(id: string, gotAll: boolean, counters: any[]): void {
        let cache = this.countersByDocId.get(id);
        if (!cache) {
            cache = { gotAll, data: CaseInsensitiveKeysMap.create<number>() };
        }

        for (const counterJson of counters) {
            const counterName = counterJson["CounterName"] as string;
            const totalValue = counterJson["TotalValue"] as number;
            if (counterName && totalValue) {
                cache.data.set(counterName, totalValue);
            }
        }

        cache.gotAll = gotAll;
        this._countersByDocId.set(id, cache);
    }

    private _setGotAllInCacheIfNeeded(countersToInclude: { [key: string]: string[] }): void {
        for (const [key, value] of Object.entries(countersToInclude)) {
            if (value.length > 0) {
                continue;
            }

            this._setGotAllCountersForDocument(key);
        }
    }

    private _setGotAllCountersForDocument(id: string): void {
        let cache = this.countersByDocId.get(id);
        if (!cache) {
            cache = { gotAll: false, data: CaseInsensitiveKeysMap.create<number>() };
        }

        cache.gotAll = true;
        this._countersByDocId.set(id, cache);
    }

    private _registerMissingCounters(ids: string[], countersToInclude: string[]): void;
    private _registerMissingCounters(countersToInclude: { [key: string]: string[] }): void;
    private _registerMissingCounters(
        idsOrCountersToInclude: string[] | { [key: string]: string[] }, countersToInclude?: string[]): void {
        if (Array.isArray(idsOrCountersToInclude)) {
            this._registerMissingCountersWithIdsList(idsOrCountersToInclude, countersToInclude);
        } else {
            this._registerMissingCountersWithCountersToIncludeObj(idsOrCountersToInclude);
        }
    }

    private _registerMissingCountersWithCountersToIncludeObj(countersToInclude: { [key: string]: string[] }): void {
        if (!countersToInclude) {
            return;
        }

        for (const [key, value] of Object.entries(countersToInclude)) {
            let cache = this.countersByDocId.get(key);
            if (!cache) {
                cache = { gotAll: false, data: CaseInsensitiveKeysMap.create<number>() };
                this.countersByDocId.set(key, cache);
            }

            for (const counter of value) {
                if (cache.data.has(counter)) {
                    continue;
                }

                cache.data.set(counter, null);
            }
        }
    }

    private _registerMissingCountersWithIdsList(ids: string[], countersToInclude: string[]): void {
        if (!countersToInclude) {
            return;
        }

        for (const counter of countersToInclude) {
            for (const id of ids) {
                let cache = this.countersByDocId.get(id);
                if (!cache) {
                    cache = { gotAll: false, data: CaseInsensitiveKeysMap.create<number>() };
                    this.countersByDocId.set(id, cache);
                }

                if (cache.data.has(counter)) {
                    continue;
                }

                cache.data.set(counter, null);
            }
        }
    }

    public store<TEntity extends object>(
        entity: TEntity): Promise<void>;
    public store<TEntity extends object>(
        entity: TEntity,
        callback?: ErrorFirstCallback<void>): Promise<void>;
    public store<TEntity extends object>(
        entity: TEntity,
        id?: string,
        callback?: ErrorFirstCallback<void>): Promise<void>;
    public store<TEntity extends object>(
        entity: TEntity,
        id?: string,
        documentType?: DocumentType<TEntity>,
        callback?: ErrorFirstCallback<void>): Promise<void>;
    public store<TEntity extends object>(
        entity: TEntity,
        id?: string,
        options?: StoreOptions<TEntity>,
        callback?: ErrorFirstCallback<void>): Promise<void>;
    public store<TEntity extends object>(
        entity: TEntity,
        idOrCallback?:
            string | ErrorFirstCallback<void>,
        docTypeOrOptionsOrCallback?:
            DocumentType<TEntity> | StoreOptions<TEntity> | ErrorFirstCallback<void>,
        callback?: ErrorFirstCallback<void>): Promise<void> {

        let id: string = null;
        let documentType: DocumentType<TEntity> = null;
        let options: StoreOptions<TEntity> = {};

        // figure out second arg
        if (TypeUtil.isString(idOrCallback) || !idOrCallback) {
            // if it's a string and registered type
            id = idOrCallback as string;
        } else if (TypeUtil.isFunction(idOrCallback)) {
            callback = idOrCallback as ErrorFirstCallback<void>;
        } else {
            throwError("InvalidArgumentException", "Invalid 2nd parameter: must be id string or callback.");
        }

        // figure out third arg
        if (TypeUtil.isDocumentType<TEntity>(docTypeOrOptionsOrCallback)) {
            documentType = docTypeOrOptionsOrCallback as DocumentType<TEntity>;
        } else if (TypeUtil.isFunction(docTypeOrOptionsOrCallback)) {
            callback = docTypeOrOptionsOrCallback as ErrorFirstCallback<void>;
        } else if (TypeUtil.isObject(docTypeOrOptionsOrCallback)) {
            options = docTypeOrOptionsOrCallback as StoreOptions<TEntity>;
        }

        callback = callback || TypeUtil.NOOP;

        const changeVector = options.changeVector;
        documentType = documentType || options.documentType;
        this.conventions.tryRegisterJsType(documentType);
        if (entity.constructor !== Object) {
            this.conventions.tryRegisterJsType(entity.constructor as ClassConstructor);
        }

        let forceConcurrencyCheck: ConcurrencyCheckMode;
        if (!TypeUtil.isUndefined(changeVector)) {
            forceConcurrencyCheck = changeVector === null ? "Disabled" : "Forced";
        } else if (!TypeUtil.isNullOrUndefined(id)) {
            forceConcurrencyCheck = "Auto";
        } else {
            const hasId = this._generateEntityIdOnTheClient.tryGetIdFromInstance(entity);
            forceConcurrencyCheck = !hasId ? "Forced" : "Auto";
        }

        const result = BluebirdPromise.resolve()
            .then(() => this._storeInternal(entity, changeVector, id, forceConcurrencyCheck, documentType))
            .tap(() => callback())
            .tapCatch(err => callback(err));

        return Promise.resolve(result);
    }

    protected _generateDocumentKeysOnStore: boolean = true;

    private async _storeInternal(
        entity: object,
        changeVector: string,
        id: string,
        forceConcurrencyCheck: ConcurrencyCheckMode,
        documentType: DocumentType): Promise<void> {
        if (this.noTracking) {
            throwError(
                "InvalidOperationException", 
                "Cannot store entity. Entity tracking is disabled in this session.");
        }

        if (!entity) {
            throwError("InvalidArgumentException", "Entity cannot be null or undefined.");
        }

        const value = this.documentsByEntity.get(entity);
        if (value) {
            value.changeVector = changeVector || value.changeVector;
            value.concurrencyCheckMode = forceConcurrencyCheck;
            return;
        }

        if (!id) {
            if (this._generateDocumentKeysOnStore) {
                id = await this._generateEntityIdOnTheClient.generateDocumentKeyForStorage(entity);
            } else {
                this._rememberEntityForDocumentIdGeneration(entity);
            }
        } else {
            this.generateEntityIdOnTheClient.trySetIdentity(entity, id);
        }

        const cmdKey = IdTypeAndName.keyFor(id, "ClientAnyCommand", null);
        if (this.deferredCommandsMap.has(cmdKey)) {
            throwError("InvalidOperationException",
                "Can't store document, there is a deferred command registered "
                + "for this document in the session. Document id: " + id);
        }

        if (this.deletedEntities.has(entity)) {
            throwError("InvalidOperationException",
                "Can't store object, it was already deleted in this session.  Document id: " + id);
        }

        // we make the check here even if we just generated the ID
        // users can override the ID generation behavior, and we need
        // to detect if they generate duplicates.
        this._assertNoNonUniqueInstance(entity, id);

        const conventions = this._requestExecutor.conventions;
        const collectionName: string = conventions.getCollectionNameForEntity(entity);
        const metadata = {};
        if (collectionName) {
            metadata[CONSTANTS.Documents.Metadata.COLLECTION] = collectionName;
        }

        const entityType = documentType
                ? conventions.getJsTypeByDocumentType(documentType)
                : conventions.getTypeDescriptorByEntity(entity);
        const jsType = conventions.getJsTypeName(entityType);
        if (jsType) {
            metadata[CONSTANTS.Documents.Metadata.RAVEN_JS_TYPE] = jsType;
        }

        if (id) {
            this._knownMissingIds.delete(id);
        }

        this._storeEntityInUnitOfWork(id, entity, changeVector, metadata, forceConcurrencyCheck, documentType);
    }

    protected _storeEntityInUnitOfWork(
        id: string,
        entity: object,
        changeVector: string,
        metadata: object,
        forceConcurrencyCheck: ConcurrencyCheckMode,
        documentType: DocumentType): void {
        this.deletedEntities.delete(entity);

        if (id) {
            this._knownMissingIds.delete(id);
        }

        const documentInfo = new DocumentInfo();
        documentInfo.id = id;
        documentInfo.metadata = metadata;
        documentInfo.changeVector = changeVector;
        documentInfo.concurrencyCheckMode = forceConcurrencyCheck;
        documentInfo.entity = entity;
        documentInfo.newDocument = true;
        documentInfo.document = null;

        this.documentsByEntity.set(entity, documentInfo);

        if (id) {
            this.documentsById.add(documentInfo);
        }
    }

    protected _rememberEntityForDocumentIdGeneration(entity: object): void {
        throwError("NotImplementedException",
            "You cannot set GenerateDocumentIdsOnStore to false"
            + " without implementing RememberEntityForDocumentIdGeneration");
    }

    public prepareForSaveChanges(): SaveChangesData {
        const result = this._newSaveChangesData();

        this._deferredCommands.length = 0;
        this.deferredCommandsMap.clear();

        this._prepareForEntitiesDeletion(result, null);
        this._prepareForEntitiesPuts(result);

        this._prepareCompareExchangeEntities(result);

        if (this._deferredCommands.length) {
            // this allow OnBeforeStore to call Defer during the call to include
            // additional values during the same SaveChanges call
            result.deferredCommands.push(...this._deferredCommands);
            for (const item of this.deferredCommandsMap.entries()) {
                result.deferredCommandsMap.set(item[0], item[1]);
            }

            this._deferredCommands.length = 0;
            this.deferredCommandsMap.clear();
        }

        for (const deferredCommand of result.deferredCommands) {
            if (deferredCommand.onBeforeSaveChanges) {
                deferredCommand.onBeforeSaveChanges(this);
            }
        }

        return result;
    }

    public validateClusterTransaction(result: SaveChangesData): void {
        if (this._transactionMode !== "ClusterWide") {
            return;
        }
        
        if (this.useOptimisticConcurrency) {
            throwError(
                "InvalidOperationException", 
                "useOptimisticConcurrency is not supported with TransactionMode set to " 
                    + "ClusterWide" as TransactionMode);
        }

        for (const commandData of result.sessionCommands) {
            switch (commandData.type) {
                case "PUT":
                case "DELETE":
                    if (commandData.changeVector) {
                        throwError(
                            "InvalidOperationException", 
                            "Optimistic concurrency for " 
                            + commandData.id + " is not supported when using a cluster transaction.");
                    }
                    break;
                case "CompareExchangeDELETE":
                case "CompareExchangePUT":
                    break;
                default:
                    throwError(
                        "InvalidOperationException",
                        "The command '" + commandData.type + "' is not supported in a cluster session.");
            }
        }
    }

    protected _updateSessionAfterSaveChanges(result: BatchCommandResult): void {
        const returnedTransactionIndex = result.transactionIndex;
        this._documentStore.setLastTransactionIndex(this.databaseName, returnedTransactionIndex);
        this.sessionInfo.lastClusterTransactionIndex = returnedTransactionIndex;
    }

    private _prepareCompareExchangeEntities(result: SaveChangesData): void {
        const clusterTransactionOperations = this._clusterSession;
        if (!clusterTransactionOperations || !clusterTransactionOperations.hasCommands()) {
            return;
        }

        if (this._transactionMode !== "ClusterWide") {
            throwError(
                "InvalidOperationException", 
                "Performing cluster transaction operation require the TransactionMode to be set to ClusterWide");
        }

        if (clusterTransactionOperations.storeCompareExchange) {
            for (const [key, value] of clusterTransactionOperations.storeCompareExchange.entries()) {
                let entityAsTree = EntityToJson.convertEntityToJson(
                            value.entity, this.conventions, null, false);
                if (this.conventions.remoteEntityFieldNameConvention) {
                    entityAsTree = this.conventions.transformObjectKeysToRemoteFieldNameConvention(entityAsTree);
                }
                
                const rootNode = { Object: entityAsTree };
                result.sessionCommands.push(
                    new PutCompareExchangeCommandData(key, rootNode, value.index));
            }
        }

        if (clusterTransactionOperations.deleteCompareExchange) {
            for (const [key, value] of clusterTransactionOperations.deleteCompareExchange.entries()) {
                result.sessionCommands.push(
                    new DeleteCompareExchangeCommandData(key, value));
            }
        }

        clusterTransactionOperations.clear();
    }

    protected abstract _clusterSession: ClusterTransactionOperationsBase;

    private _newSaveChangesData(): SaveChangesData {
        return new SaveChangesData({
            deferredCommands: [...this._deferredCommands],
            deferredCommandsMap: new Map(this.deferredCommandsMap),
            options: this._saveChangesOptions
        });
    }

    private _prepareForEntitiesDeletion(result: SaveChangesData, changes: { [id: string]: DocumentsChanges[] }): void {
        for (const deletedEntity of this.deletedEntities) {
            let documentInfo = this.documentsByEntity.get(deletedEntity);
            if (!documentInfo) {
                continue;
            }

            if (changes) {
                const docChanges = [];
                const change = new DocumentsChanges();
                change.fieldNewValue = "";
                change.fieldOldValue = "";
                change.change = "DocumentDeleted";

                docChanges.push(change);
                changes[documentInfo.id] = docChanges;
            } else {
                const command: ICommandData =
                    result.deferredCommandsMap.get(IdTypeAndName.keyFor(documentInfo.id, "ClientAnyCommand", null));
                if (command) {
                    InMemoryDocumentSessionOperations._throwInvalidDeletedDocumentWithDeferredCommand(command);
                }

                let changeVector = null;
                documentInfo = this.documentsById.getValue(documentInfo.id);

                if (documentInfo) {
                    changeVector = documentInfo.changeVector;

                    if (documentInfo.entity) {
                        this.documentsByEntity.delete(documentInfo.entity);
                        result.entities.push(documentInfo.entity);
                    }

                    this.documentsById.remove(documentInfo.id);
                }

                changeVector = this.useOptimisticConcurrency ? changeVector : null;
                const beforeDeleteEventArgs =
                    new SessionBeforeDeleteEventArgs(this, documentInfo.id, documentInfo.entity);
                this.emit("beforeDelete", beforeDeleteEventArgs);
                result.sessionCommands.push(new DeleteCommandData(documentInfo.id, changeVector));
            }

            if (!changes) {
                this.deletedEntities.clear();
            }
        }

    }

    private _prepareForEntitiesPuts(result: SaveChangesData): void {
        for (const entry of this.documentsByEntity.entries()) {
            const [entityKey, entityValue] = entry;

            if (entityValue.ignoreChanges) {
                continue;
            }

            const dirtyMetadata = InMemoryDocumentSessionOperations._updateMetadataModifications(entityValue);

            let document = this.entityToJson.convertEntityToJson(entityKey, entityValue);
            if (!this._entityChanged(document, entityValue, null) && !dirtyMetadata) {
                continue;
            }

            const command = result.deferredCommandsMap.get(
                IdTypeAndName.keyFor(entityValue.id, "ClientModifyDocumentCommand", null));
            if (command) {
                InMemoryDocumentSessionOperations._throwInvalidModifiedDocumentWithDeferredCommand(command);
            }

            const beforeStoreEventArgs = new SessionBeforeStoreEventArgs(this, entityValue.id, entityKey);
            if (this.emit("beforeStore", beforeStoreEventArgs)) {
                if (beforeStoreEventArgs.isMetadataAccessed()) {
                    InMemoryDocumentSessionOperations._updateMetadataModifications(entityValue);
                }

                if (beforeStoreEventArgs.isMetadataAccessed() || this._entityChanged(document, entityValue, null)) {
                    document = this.entityToJson.convertEntityToJson(entityKey, entityValue);
                }
            }

            entityValue.newDocument = false;
            result.entities.push(entityKey);

            if (entityValue.id) {
                this.documentsById.remove(entityValue.id);
            }

            entityValue.document = document;

            let changeVector: string;
            if (this.useOptimisticConcurrency) {
                if (entityValue.concurrencyCheckMode !== "Disabled") {
                    // if the user didn't provide a change vector, we'll test for an empty one
                    changeVector = entityValue.changeVector || "";
                } else {
                    changeVector = null;
                }
            } else if (entityValue.concurrencyCheckMode === "Forced") {
                changeVector = entityValue.changeVector;
            } else {
                changeVector = null;
            }

            result.sessionCommands.push(
                new PutCommandDataWithJson(entityValue.id, changeVector, document));
        }
    }

    protected _entityChanged(
        newObj: object,
        documentInfo: DocumentInfo,
        changes: { [id: string]: DocumentsChanges[] }): boolean {
        return JsonOperation.entityChanged(newObj, documentInfo, changes);
    }

    private static _throwInvalidModifiedDocumentWithDeferredCommand(resultCommand: ICommandData): void {
        throwError("InvalidOperationException", "Cannot perform save because document " + resultCommand.id
            + " has been modified by the session and is also taking part in deferred "
            + resultCommand.type + " command");
    }

    private static _throwInvalidDeletedDocumentWithDeferredCommand(resultCommand: ICommandData): void {
        throwError("InvalidOperationException", "Cannot perform save because document " + resultCommand.id
            + " has been deleted by the session and is also taking part in deferred "
            + resultCommand.type + " command");
    }

    private static _updateMetadataModifications(documentInfo: DocumentInfo) {
        let dirty = false;

        if (documentInfo.metadataInstance) {
            if (documentInfo.metadataInstance.isDirty()) {
                dirty = true;
            }

            for (const prop of Object.keys(documentInfo.metadataInstance)) {
                const propValue = documentInfo.metadataInstance[prop];
                if (!propValue ||
                    (typeof propValue["isDirty"] === "function"
                        && (propValue as IMetadataDictionary).isDirty())) {
                    dirty = true;
                }

                documentInfo.metadata[prop] = ObjectUtil.clone(documentInfo.metadataInstance[prop]);
            }
        }

        return dirty;
    }

    public async delete(id: string): Promise<void>;
    public async delete(id: string, expectedChangeVector: string): Promise<void>;
    public async delete<TEntity extends IRavenObject>(entity: TEntity): Promise<void>;
    public async delete<TEntity extends IRavenObject>(
        idOrEntity: string | TEntity, expectedChangeVector: string = null): Promise<void> {
        if (TypeUtil.isString(idOrEntity)) {
            this._deleteById(idOrEntity as string, expectedChangeVector);
            return;
        }

        this._deleteByEntity(idOrEntity as TEntity);
    }

    /**
     * Marks the specified entity for deletion. The entity will be deleted when SaveChanges is called.
     */
    private _deleteByEntity<TEntity extends IRavenObject>(entity: TEntity) {
        if (!entity) {
            throwError("InvalidArgumentException", "Entity cannot be null.");
        }

        const value = this.documentsByEntity.get(entity);
        if (!value) {
            throwError("InvalidOperationException",
                entity + " is not associated with the session, cannot delete unknown entity instance");
        }

        this.deletedEntities.add(entity);
        this.includedDocumentsById.delete(value.id);
        
        if (this._countersByDocId) {
            this._countersByDocId.delete(value.id);
        }

        this._knownMissingIds.add(value.id);
    }

    /**
     * Marks the specified entity for deletion. The entity will be deleted when IDocumentSession.SaveChanges is called.
     * WARNING: This method will not call beforeDelete listener!
     */
    private _deleteById(id: string): void;
    private _deleteById(id: string, expectedChangeVector: string): void;
    private _deleteById(id: string, expectedChangeVector: string = null): void {
        if (!id) {
            throwError("InvalidArgumentException", "Id cannot be null.");
        }

        let changeVector = null;
        const documentInfo = this.documentsById.getValue(id);
        if (documentInfo) {
            const newObj = this.entityToJson.convertEntityToJson(documentInfo.entity, documentInfo);
            if (documentInfo.entity && this._entityChanged(newObj, documentInfo, null)) {
                throwError("InvalidOperationException",
                    "Can't delete changed entity using identifier. Use delete(T entity) instead.");
            }

            if (documentInfo.entity) {
                this.documentsByEntity.delete(documentInfo.entity);
            }

            this.documentsById.remove(id);
            changeVector = documentInfo.changeVector;
        }

        this._knownMissingIds.add(id);
        changeVector = this.useOptimisticConcurrency ? changeVector : null;
        
        if (this._countersByDocId) {
            this._countersByDocId.delete(id);
        }

        this.defer(new DeleteCommandData(id, expectedChangeVector || changeVector));
    }

    /**
     * Defer commands to be executed on saveChanges()
     */
    public defer(...commands: ICommandData[]) {
        this._deferredCommands.push(...commands);
        for (const command of commands) {
            this._deferInternal(command);
        }
    }

    private _deferInternal(command: ICommandData): void {
        if (command.type === "BatchPATCH") {
            const batchPatchCommand = command as BatchPatchCommandData;
            for (const kvp of batchPatchCommand.ids) {
                this._addCommand(command, kvp.id, "PATCH", command.name);
            }

            return;
        }

        this._addCommand(command, command.id, command.type, command.name);
    }
    
    private _addCommand(command: ICommandData, id: string, commandType: CommandType, commandName: string): void {
        this.deferredCommandsMap.set(
            IdTypeAndName.keyFor(id, commandType, commandName), command);
        this.deferredCommandsMap.set(
            IdTypeAndName.keyFor(id, "ClientAnyCommand", null), command);

        if (command.type !== "AttachmentPUT"
            && command.type !== "AttachmentDELETE"
            && command.type !== "AttachmentCOPY"
            && command.type !== "AttachmentMOVE"
            && command.type !== "Counters") {
            this.deferredCommandsMap.set(
                IdTypeAndName.keyFor(id, "ClientModifyDocumentCommand", null), command);
        }
    }

    protected _refreshInternal<T extends object>(
        entity: T, cmd: RavenCommand<GetDocumentsResult>, documentInfo: DocumentInfo): void {
        const document = cmd.result.results[0];
        if (!document) {
            throwError("InvalidOperationException",
                "Document '" + documentInfo.id + "' no longer exists and was probably deleted");
        }

        const value = document[CONSTANTS.Documents.Metadata.KEY];
        documentInfo.metadata = value;

        if (documentInfo.metadata) {
            const changeVector = value[CONSTANTS.Documents.Metadata.CHANGE_VECTOR];
            documentInfo.changeVector = changeVector;
        }

        documentInfo.document = document;
        const entityType = this.conventions.getTypeDescriptorByEntity(entity);
        documentInfo.entity = this.entityToJson.convertToEntity(entityType, documentInfo.id, document);

        Object.assign(entity, documentInfo.entity);
    }

    /**
     * Gets a value indicating whether any of the entities tracked by the session has changes.
     */
    public hasChanges(): boolean {
        for (const entity of this.documentsByEntity.entries()) {
            const document = this.entityToJson.convertEntityToJson(entity[0], entity[1]);
            if (this._entityChanged(document, entity[1], null)) {
                return true;
            }
        }

        return !!this.deletedEntities.size;
    }

    /**
     * Evicts the specified entity from the session.
     * Remove the entity from the delete queue and stops tracking changes for this entity.
     */
    public evict<T extends object>(entity: T): void {
        const documentInfo = this.documentsByEntity.get(entity);
        if (documentInfo) {
            this.documentsByEntity.delete(entity);
            this.documentsById.remove(documentInfo.id);
        }

        this.deletedEntities.delete(entity);
        if (this._countersByDocId) {
            this._countersByDocId.delete(documentInfo.id);
        }
    }

    /**
     * Clears this instance.
     * Remove all entities from the delete queue and stops tracking changes for all entities.
     */
    public clear(): void {
        this.documentsByEntity.clear();
        this.deletedEntities.clear();
        this.documentsById.clear();
        this._knownMissingIds.clear();
        if (this._countersByDocId) {
            this._countersByDocId.clear();
        }
    }

    /**
     * Determines whether the specified entity has changed.
     */
    public hasChanged(entity: object): boolean {
        const documentInfo = this.documentsByEntity.get(entity);

        if (!documentInfo) {
            return false;
        }

        const document = this.entityToJson.convertEntityToJson(entity, documentInfo);
        return this._entityChanged(document, documentInfo, null);
    }

    /**
     * SaveChanges will wait for the changes made to be replicates to `replicas` nodes
     */
    public waitForReplicationAfterSaveChanges();
    /**
     * SaveChanges will wait for the changes made to be replicates to `replicas` nodes
     */
    public waitForReplicationAfterSaveChanges(opts: ReplicationBatchOptions);
    /**
     * SaveChanges will wait for the changes made to be replicates to `replicas` nodes
     */
    public waitForReplicationAfterSaveChanges(opts?: ReplicationBatchOptions) {
        if (!this._saveChangesOptions) {
            this._saveChangesOptions = {
                indexOptions: null,
                replicationOptions: null
            };
        }

        opts = opts || {};

        this._saveChangesOptions.replicationOptions = {
            replicas: opts.replicas || 1,
            throwOnTimeout: TypeUtil.isUndefined(opts.throwOnTimeout) ? true : opts.throwOnTimeout,
            majority: TypeUtil.isNullOrUndefined(opts.majority) ? false : opts.majority,
            timeout: opts.timeout || 15000
        } as ReplicationBatchOptions;
    }

    /**
     * SaveChanges will wait for the indexes to catch up with the saved changes
     */
    public waitForIndexesAfterSaveChanges();
    /**
     * SaveChanges will wait for the indexes to catch up with the saved changes
     */
    public waitForIndexesAfterSaveChanges(opts: IndexBatchOptions);
    /**
     * SaveChanges will wait for the indexes to catch up with the saved changes
     */
    public waitForIndexesAfterSaveChanges(opts?: IndexBatchOptions) {
        if (!this._saveChangesOptions) {
            this._saveChangesOptions = {
                indexOptions: null,
                replicationOptions: null
            };
        }

        opts = opts || {};

        this._saveChangesOptions.indexOptions = {
            indexes: opts.indexes || [],
            throwOnTimeout: TypeUtil.isNullOrUndefined(opts.throwOnTimeout) ? true : opts.throwOnTimeout,
            timeout: opts.timeout || 15000
        };
    }

    /**
     * Mark the entity as one that should be ignore for change tracking purposes,
     * it still takes part in the session, but is ignored for SaveChanges.
     */
    public ignoreChangesFor(entity: object): void {
        this._getDocumentInfo(entity).ignoreChanges = true;
    }

    public whatChanged(): { [id: string]: DocumentsChanges[] } {
        const changes: { [id: string]: DocumentsChanges[] } = {};

        this._prepareForEntitiesDeletion(null, changes);
        this._getAllEntitiesChanges(changes);

        return changes;
    }

    private _getAllEntitiesChanges(changes: { [id: string]: DocumentsChanges[] }): void {
        for (const pair of this.documentsById.entries()) {
            InMemoryDocumentSessionOperations._updateMetadataModifications(pair[1]);
            const newObj = this.entityToJson.convertEntityToJson(pair[1].entity, pair[1]);
            this._entityChanged(newObj, pair[1], changes);
        }
    }

    public dispose(isDisposing?: boolean): void {
        if (this._disposed) {
            return;
        }

        this._disposed = true;
    }

    public get transactionMode() {
        return this._transactionMode;
    }

    public set transactionMode(value) {
        this._transactionMode = value;
    }

    private static _throwNoDatabase(): never {
        return throwError(
            "InvalidOperationException",
            "Cannot open a Session without specifying a name of a database " +
            "to operate on. Database name can be passed as an argument when Session is" +
                " being opened or default database can be defined using 'DocumentStore.setDatabase()' method");
    }
}
