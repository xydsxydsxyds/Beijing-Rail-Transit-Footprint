const DB_NAME="beijing-rail-footprint",DB_VERSION=1,STORE="footprints";
export const ACTIVE_KEY="beijing-rail-footprint-active-id";

const requestResult=request=>new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)});
export async function openFootprintDb(){const request=indexedDB.open(DB_NAME,DB_VERSION);request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains(STORE))db.createObjectStore(STORE,{keyPath:"id"})};return requestResult(request)}
async function store(mode="readonly"){const db=await openFootprintDb();return db.transaction(STORE,mode).objectStore(STORE)}
export async function listFootprints(){const records=await requestResult((await store()).getAll());return records.sort((a,b)=>new Date(b.updatedAt)-new Date(a.updatedAt))}
export async function getFootprint(id){return id?requestResult((await store()).get(id)):null}
export async function putFootprint(record){await requestResult((await store("readwrite")).put(record));return record}
export async function deleteFootprint(id){await requestResult((await store("readwrite")).delete(id))}
export const newId=()=>`footprint-${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
