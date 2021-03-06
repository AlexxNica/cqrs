import { Actor, ActorConstructor } from "./Actor";
import Service from "./Service";
import {getAlias} from "./eventAlias";
import Event from "./Event";
import Repository from "./Repository";
import EventStore from "./DefaultEventStore";
import DomainServer from "./DomainServer";
import DomainProxy from "./DomainProxy";
import EventBus from "./EventBus";
const isLock = Symbol.for("isLock");
const debug = require('debug')('domain');
const uid = require("uuid").v1;
const getActorProxy = Symbol.for("getActorProxy");
import DefaultClusterInfoManager from "./DefaultClusterInfoManager";
import Role from "./Role";

export default class Domain {

    public eventstore: EventStore;
    public eventbus: EventBus;
    public ActorClassMap: Map<string, ActorConstructor>;
    public repositorieMap: Map<ActorConstructor, Repository>;
    private clusterInfoManager: DefaultClusterInfoManager;
    private domainServer: DomainServer;
    private domainProxy: DomainProxy;
    private roleMap:Map<string,Role> = new Map();

    public readonly id;

    constructor(options: any = {}) {
        this.id = uid();
        this.ActorClassMap = new Map();

        // cluster system
        if (
            options.domainServerUrl &&
            options.domainServerPort &&
            (options.clusterUrl || options.clusterPort)
        ) {
            this.clusterInfoManager = new DefaultClusterInfoManager(options.clusterUrl || options.clusterPort);
            this.clusterInfoManager.register({ id: this.id, url: options.domainServerUrl });
            this.domainServer = new DomainServer(this, options.domainServerPort);
            this.domainProxy = new DomainProxy(this.clusterInfoManager, this.ActorClassMap);
        }

        this.eventstore = options.eventstore || (options.EventStore ? new options.EventStore : new EventStore());
        this.repositorieMap = new Map();
        this.eventbus = options.EventBus ?
            new options.EventBus(this.eventstore, this, this.repositorieMap, this.ActorClassMap) :
            new EventBus(this.eventstore, this, this.repositorieMap, this.ActorClassMap);

    }

    private async getNativeActor(type: string, id: string): Promise<any> {

        const roles = type.split(".");
        const actorType = roles.shift();

        let repo = this.repositorieMap.get(this.ActorClassMap.get(actorType));
        const actor = await repo.get(id);

        let result;

        if(roles.length){
            for(let role of roles){
               result = this.roleMap.get(role).wrap(result || actor);
            }
        }

        return result || actor;
    }

    private async nativeCreateActor(type, data) {

        const actorType = type.split(".").shift();

        const ActorClass = this.ActorClassMap.get(actorType);
        const repo = this.repositorieMap.get(ActorClass);


        if (ActorClass.createBefor) {
            try {
                data = (await ActorClass.createBefor(data, this)) || data;
            } catch (err) {
                throw err;
            }
        }
        const actorId = (await repo.create(data)).json.id;
        const actor = await this[getActorProxy](type, actorId);
        return actor;

    }

    async [getActorProxy](type: string, id: string, sagaId?: string, key?: string) {

        const that = this;

        let actor = await this.getNativeActor(type, id);

        if (!actor) {
            if(this.domainProxy)
            return await this.domainProxy.getActor(type, id, sagaId, key);
            else
            return null;
        }

        let roles;
        if(Array.isArray(actor)){
           roles = actor[1]
           actor = actor[0];
        }

        const proxy = new Proxy(actor, {
            get(target, prop: string) {
                if (prop === "then") { return proxy };

                if ("lock" === prop || "lockData" === prop) {
                    return Reflect.get(target, prop);
                }

                let member = actor[prop];
                let roleName;
                let role;
                if (prop === "json" || prop === "id") {
                   return member;
                } else {
                  if(!member){
                     if(roles){
                        for(let rn in roles){
                           role = roles[rn];
                           member = role.methods[prop];
                           roleName = rn;
                           if(member) break;
                        }
                     }else return;
                  }
                  if (typeof member === "function") {
                    if (prop in Object.prototype) return undefined;
                    return new Proxy(member, {
                        apply(target, cxt, args) {
                            return new Promise(function (resolve, reject) {
                                function run() {
                                    const islock = actor[isLock](key);

                                    if (islock) {
                                        setTimeout(run, 2000);
                                    } else {
                                        const iservice = new Service(actor, that.eventbus,
                                            (type, id, sagaId, key) => that[getActorProxy](type, id, sagaId, key),
                                            (type, data) => that.nativeCreateActor(type, id),
                                            prop, sagaId,roleName,role);

                                        const service = new Proxy(function service(type, data) {
                                            if (arguments.length === 0) {
                                                type = prop;
                                                data = null;
                                            } else if (arguments.length === 1) {
                                                data = type;
                                                type = prop;
                                            }
                                            return iservice.apply(type, data)
                                        }, {
                                                get(target, prop) {
                                                    return iservice[prop].bind(iservice);
                                                }
                                            })
                                        cxt = { service, $: service };

                                        cxt.__proto__ = proxy;
                                        let result
                                        try {
                                            result = target.call(cxt, ...args);
                                        } catch (err) {

                                            that.eventbus.rollback(sagaId || iservice.sagaId).then(r => reject(err));
                                            return;
                                        }
                                        if (result instanceof Promise) {
                                            result.then(result => {
                                                    resolve(result)
                                                }).catch(err => {
                                                    that.eventbus.rollback(sagaId || iservice.sagaId).then(r => reject(err));
                                                })
                                        } else {
                                            resolve(result);
                                        }
                                    }
                                }
                                run();
                            });
                        }
                    });
                }else return undefined;
              }
            }
        })
        return proxy;
    }

    register(Classes: ActorConstructor[] | ActorConstructor) {

        if (!Array.isArray(Classes)) {
            Classes = [Classes]
        }

        for (let Class of Classes) {
            this.ActorClassMap.set(Class.getType(), Class);
            const repo = new Repository(Class, this.eventstore,this.roleMap);

            // cluster system code
            // when repository emit create event ,then add actor's id to clusterInfoManager.
            if (this.clusterInfoManager) {
                repo.on("create", async actorJSON => {
                    await this.clusterInfoManager.addId(this.id, actorJSON.id);

                });
            }
            repo.on("create", json => {
                let event = new Event(
                  {id:json.id, type:Class.getType()}, json, "create", "create"
                )
                const alias = getAlias(event);
                for (let name of alias) {
                    this.eventbus.emitter.emit(name, json);
                }
            });
            this.repositorieMap.set(Class, repo);
        }

        return this;

    }

    async create(type: string, data: any) {
        return await this.nativeCreateActor(type, data);
    }

    async get(type: string, id: string) {
        return await this[getActorProxy](type, id);
    }

    on(event, handle) {
        this.eventbus.on(event, handle);
    }

    once(event, handle) {
        this.eventbus.on(event, handle);
    }

    public getCacheActorIds() {
        let result = [];
        for (let [key, Actor] of this.ActorClassMap) {
            result = result.concat(this.repositorieMap.get(Actor).getCacheActorIds());
        }
        return result;
    }

    public addRole(name:string|any,supportedActorNames?:string[],methods?:any,updater?:any){

        if(typeof name !== "string"){
          supportedActorNames = name.types;
          methods = name.methods;
          updater = name.updater;
          name = name.name;

        }
        if(this.roleMap.has(name)) throw new Error(name +  " role is exist. ");
        this.roleMap.set(name,new Role(name,supportedActorNames,methods,updater));
        return this;
    }

}
