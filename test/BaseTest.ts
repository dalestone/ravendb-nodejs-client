/// <reference path="../node_modules/@types/mocha/index.d.ts" />
/// <reference path="../node_modules/@types/chai/index.d.ts" />

import * as Promise from 'bluebird';
import * as _ from 'lodash';
import {RequestsExecutor} from "../src/Http/Request/RequestsExecutor";
import {IDocumentStore} from "../src/Documents/IDocumentStore";
import {IDocumentSession} from "../src/Documents/Session/IDocumentSession";
import {IndexDefinition} from "../src/Database/Indexes/IndexDefinition";
import {DocumentConventions} from "../src/Documents/Conventions/DocumentConventions";
import {IDocument} from "../src/Documents/IDocument";
import {Document} from "../src/Documents/Document";
import {CreateDatabaseCommand} from "../src/Database/Commands/CreateDatabaseCommand";
import {DatabaseDocument} from "../src/Database/DatabaseDocument";
import {IRavenCommandResponse} from "../src/Database/IRavenCommandResponse";
import {PutIndexesCommand} from "../src/Database/Commands/PutIndexesCommand";
import {DeleteDatabaseCommand} from "../src/Database/Commands/DeleteDatabaseCommand";

const defaultUrl: string = "http://localhost.fiddler:8080";
const defaultDatabase: string = "NorthWindTest";
let requestsExecutor: RequestsExecutor;
let indexMap: string;
let index: IndexDefinition;

beforeEach(function(done: MochaDone): void {
  requestsExecutor = new RequestsExecutor(
    defaultUrl, defaultDatabase, null,
    new DocumentConventions<IDocument>(Document)
  );

  indexMap = [
    'from doc in docs ',
    'select new{',
    'Tag = doc["@metadata"]["@collection"],',
    'LastModified = (DateTime)doc["@metadata"]["Last-Modified"],',
    'LastModifiedTicks = ((DateTime)doc["@metadata"]["Last-Modified"]).Ticks}'
  ].join('');

  index = new IndexDefinition("Testing", indexMap);

  requestsExecutor.execute(
    new CreateDatabaseCommand(
      new DatabaseDocument(defaultDatabase, {"Raven/DataDir": "test"})
    )
  )
  .then((): Promise.Thenable<IRavenCommandResponse> => requestsExecutor.execute(
    new PutIndexesCommand(index)
  ))
  .then((): void => {
    _.assign(this.currentTest, {
      requestsExecutor: requestsExecutor,
      defaultUrl: defaultUrl,
      defaultDatabase: defaultDatabase
    });

    done();
  });
});

afterEach(function(done: MochaDone): void {
  requestsExecutor
    .execute(new DeleteDatabaseCommand(defaultDatabase, true))
    .then((): void => done());
});