/*
 * cloudbeaver - Cloud Database Manager
 * Copyright (C) 2020 DBeaver Corp and others
 *
 * Licensed under the Apache License, Version 2.0.
 * you may not use this file except in compliance with the License.
 */

import { computed, observable } from 'mobx';
import { Subject } from 'rxjs';

import { injectable } from '@dbeaver/core/di';
import { SessionService } from '@dbeaver/core/root';
import {
  ConnectionInfo,
  DataSourceInfo,
  DriverInfo,
  GraphQLService,
  CachedResource,
  DatabaseObjectInfo,
} from '@dbeaver/core/sdk';

import { NodesManagerService } from '../NodesManager/NodesManagerService';

export type DBDriver = Pick<
  DriverInfo,
  | 'id'
  | 'name'
  | 'icon'
  | 'description'
  | 'defaultPort'
  | 'sampleURL'
  | 'embedded'
  | 'anonymousAccess'
  | 'promotedScore'
>
export type DBSource = Pick<DataSourceInfo, 'id' | 'name' | 'driverId' | 'description'>
export type Connection = Pick<ConnectionInfo, 'id' | 'name' | 'connected' | 'driverId'>
export type ObjectContainer = Pick<DatabaseObjectInfo, 'name' | 'description' | 'type' | 'features'>

type DBDriversMetadata = {
  loaded: boolean;
}

@injectable()
export class ConnectionsManagerService {

  @observable private connectionsMap: Map<string, Connection> = new Map();
  readonly dbDrivers = new CachedResource(
    new Map(),
    this.refreshDriversAsync.bind(this),
    (_, { loaded }) => loaded,
    { loaded: false }
  );
  readonly connectionObjectContainers = new CachedResource(
    new Map(),
    this.refreshObjectContainersAsync.bind(this),
    this.isObjectContainersLoaded.bind(this)
  );

  @computed get connections(): Connection[] {
    return Array.from(this.connectionsMap.values());
  }

  onOpenConnection = new Subject<Connection>();
  onCloseConnection = new Subject<string>();

  constructor(
    private graphQLService: GraphQLService,
    private nodesManagerService: NodesManagerService,
    private sessionService: SessionService
  ) {
    this.sessionService.onUpdate.subscribe(this.restoreConnections.bind(this));
  }

  getDBDrivers(): Map<string, DBDriver> {
    return this.dbDrivers.data;
  }

  async loadDriversAsync(): Promise<Map<string, DBDriver>> {
    return this.dbDrivers.load();
  }

  addOpenedConnection(connection: Connection) {
    this.connectionsMap.set(connection.id, connection);
    this.onOpenConnection.next(connection);
    this.nodesManagerService.updateRootChildren(); // Update connections list, probably here we must also request node info and add it to nodes manager
  }

  getConnectionById(connectionId: string): Connection | undefined {
    return this.connectionsMap.get(connectionId);
  }

  getObjectContainerById(
    connectionId: string,
    objectCatalogId: string,
    objectSchemaId?: string
  ): ObjectContainer | undefined {
    const objectContainers = this.connectionObjectContainers.data.get(connectionId);
    if (!objectContainers) {
      return;
    }
    return objectContainers.find(
      objectContainer => objectContainer.name === objectSchemaId || objectContainer.name === objectCatalogId
    );
  }

  hasAnyConnection(): boolean {
    return Boolean(this.connections.length);
  }

  async closeAllConnections(): Promise<void> {
    for (const connection of this.connections) {
      await this.closeConnectionAsync(connection.id, true);
    }
    await this.nodesManagerService.updateRootChildren();
  }

  async closeConnectionAsync(id: string, skipNodesRefresh?: boolean): Promise<void> {
    await this.graphQLService.gql.closeConnection({ id });
    await this.afterConnectionClose(id);
    this.connectionsMap.delete(id);

    if (!skipNodesRefresh) {
      await this.nodesManagerService.updateRootChildren(); // Update connections list, probably here we must just remove nodes from nodes manager
    }
  }

  async loadObjectContainer(connectionId: string, catalogId?: string): Promise<ObjectContainer[]> {
    const data = await this.connectionObjectContainers.load(connectionId, catalogId);
    return data.get(connectionId)!;
  }

  private async afterConnectionClose(id: string) {
    await this.nodesManagerService.closeConnection(id);
    this.onCloseConnection.next(id);
  }

  private async restoreConnections() {
    const config = await this.sessionService.session.load();
    if (!config) {
      return;
    }

    let connectionsToRemove = this.connections.concat();
    // TODO: connections must be string[]
    for (const connection of config.connections) {
      await this.restoreConnection(connection);
      connectionsToRemove = connectionsToRemove.filter(({ id }) => id !== connection.id);
    }

    for (const connection of connectionsToRemove) {
      await this.afterConnectionClose(connection.id);
      this.connectionsMap.delete(connection.id);
    }

    await this.nodesManagerService.updateRootChildren();
  }

  private isObjectContainersLoaded(
    data: Map<string, ObjectContainer[]>,
    metadata: {},
    connectionId: string,
    catalogId?: string,
  ) {
    return data.has(connectionId);
  }

  private async refreshObjectContainersAsync(
    data: Map<string, ObjectContainer[]>,
    metadata: {},
    update: boolean,
    connectionId: string,
    catalogId?: string,
  ): Promise<Map<string, ObjectContainer[]>> {
    const { navGetStructContainers } = await this.graphQLService.gql.navGetStructContainers({
      connectionId,
      catalogId,
    });
    data.set(connectionId, [...navGetStructContainers.schemaList, ...navGetStructContainers.catalogList]);

    return data;
  }

  private async refreshDriversAsync(
    data: Map<string, DBDriver>,
    metadata: DBDriversMetadata,
    update: boolean
  ): Promise<Map<string, DBDriver>> {
    const { driverList } = await this.graphQLService.gql.driverList();

    data.clear();

    for (const driver of driverList) {
      data.set(driver.id, driver);
    }
    metadata.loaded = true;
    return data;
  }

  private async restoreConnection(connection: Connection) {
    // TODO: Must be loaded based on connection id
    // const { connection } = await this.graphQLService.gql.connectionState({ id });

    if (this.connectionsMap.has(connection.id)) {
      return;
    }
    this.connectionsMap.set(connection.id, connection);
    this.onOpenConnection.next(connection);
  }
}
