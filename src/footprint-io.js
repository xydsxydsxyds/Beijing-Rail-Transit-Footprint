export const FILE_SCHEMA_VERSION="1.0.0",SCORING_VERSION="1.0.0",APP_VERSION="0.1.0";
export function validateImport(data,network){
 const errors=[],ignored=[],segmentIds=new Set(network.segments.map(x=>x.id)),stationIds=new Set(network.stations.map(x=>x.id)),allowed=new Set(["board_or_alight","in_station_transfer","out_of_station_transfer"]);
 if(!data||typeof data!=="object"||Array.isArray(data))errors.push("文件根节点必须是对象");
 const required=["schemaVersion","datasetVersion","scoringVersion","title","selectedSegmentIds","stationVisits","createdAt","updatedAt"],properties=new Set([...required,"appVersion","notes"]),semver=/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,idPattern=/^[a-z0-9][a-z0-9._-]{0,99}$/;
 for(const key of required)if(!(key in(data||{})))errors.push(`缺少必填字段：${key}`);for(const key of Object.keys(data||{}))if(!properties.has(key))errors.push(`不允许的字段：${key}`);
 if(data?.schemaVersion!==FILE_SCHEMA_VERSION)errors.push(`不支持的用户文件版本：${data?.schemaVersion??"缺失"}`);
 if(data?.datasetVersion!==network.meta.datasetVersion)errors.push(`数据集版本不一致：文件为 ${data?.datasetVersion??"缺失"}，当前为 ${network.meta.datasetVersion}`);
 if(data?.scoringVersion!==SCORING_VERSION)errors.push(`积分规则版本不一致：${data?.scoringVersion??"缺失"}`);
 if(data?.appVersion!==undefined&&!semver.test(data.appVersion))errors.push("appVersion 不是有效版本号");
 if(typeof data?.title!=="string"||!data.title.trim()||data.title.length>100)errors.push("标题缺失或超过 100 字");
 if(data?.notes!==undefined&&(typeof data.notes!=="string"||data.notes.length>2000))errors.push("notes 必须是不超过 2000 字的文本");
 for(const key of ["createdAt","updatedAt"])if(typeof data?.[key]!=="string"||!Number.isFinite(Date.parse(data[key])))errors.push(`${key} 不是有效日期时间`);
 if(!Array.isArray(data?.selectedSegmentIds))errors.push("selectedSegmentIds 必须是数组");
 if(!Array.isArray(data?.stationVisits))errors.push("stationVisits 必须是数组");
 if(Array.isArray(data?.selectedSegmentIds)&&new Set(data.selectedSegmentIds).size!==data.selectedSegmentIds.length)errors.push("selectedSegmentIds 包含重复项");
 for(const id of Array.isArray(data?.selectedSegmentIds)?data.selectedSegmentIds:[])if(typeof id!=="string"||!idPattern.test(id))errors.push(`区间 ID 格式错误：${id}`);
 const selectedSegmentIds=[...new Set((Array.isArray(data?.selectedSegmentIds)?data.selectedSegmentIds:[]).filter(id=>{if(segmentIds.has(id))return true;ignored.push(`无法映射区间：${id}`);return false}))];
 const seen=new Set(),stationVisits=[];for(const visit of Array.isArray(data?.stationVisits)?data.stationVisits:[]){if(!visit||typeof visit!=="object"||Array.isArray(visit)){errors.push("stationVisits 中存在非对象记录");continue}for(const key of Object.keys(visit))if(!["stationId","visitTypes"].includes(key))errors.push(`车站记录含不允许字段：${key}`);if(typeof visit.stationId!=="string"||!idPattern.test(visit.stationId)){errors.push(`车站 ID 格式错误：${visit.stationId??"缺失"}`);continue}if(!Array.isArray(visit.visitTypes)||!visit.visitTypes.length||new Set(visit.visitTypes).size!==visit.visitTypes.length||visit.visitTypes.some(x=>!allowed.has(x))){errors.push(`车站行为类型无效：${visit.stationId}`);continue}if(!stationIds.has(visit.stationId)){ignored.push(`无法映射车站：${visit.stationId}`);continue}if(seen.has(visit.stationId)){ignored.push(`重复车站记录：${visit.stationId}`);continue}seen.add(visit.stationId);stationVisits.push({stationId:visit.stationId,visitTypes:[...visit.visitTypes]})}
 return{errors,ignored,clean:{...data,title:data?.title?.trim(),selectedSegmentIds,stationVisits}};
}
export function isolatedVisits(file,network){const lineStations=new Map(network.lineStations.map(x=>[x.id,x.stationId])),adjacent=new Set();for(const id of file.selectedSegmentIds){const s=network.segments.find(x=>x.id===id);if(s){adjacent.add(lineStations.get(s.fromLineStationId));adjacent.add(lineStations.get(s.toLineStationId))}}return file.stationVisits.filter(x=>!adjacent.has(x.stationId)).map(x=>network.stations.find(s=>s.id===x.stationId)?.nameZh||x.stationId)}
export function missingContinuousEndpoints(file,network){
 const selected=new Set(file.selectedSegmentIds),visited=new Set(file.stationVisits.map(x=>x.stationId)),lineStationToStation=new Map(network.lineStations.map(x=>[x.id,x.stationId])),stationNames=new Map(network.stations.map(x=>[x.id,x.nameZh]));
 const groupedLines=new Set(),groups=[];for(const service of network.throughServices||[]){groups.push({name:service.nameZh,lineIds:new Set(service.lineIds)});service.lineIds.forEach(id=>groupedLines.add(id))}for(const line of network.lines)if(!groupedLines.has(line.id))groups.push({name:line.nameZh,lineIds:new Set([line.id])});
 const missing=[];for(const group of groups){const edges=network.segments.filter(x=>selected.has(x.id)&&group.lineIds.has(x.lineId)).map(x=>({...x,from:lineStationToStation.get(x.fromLineStationId),to:lineStationToStation.get(x.toLineStationId)})).filter(x=>x.from&&x.to);if(!edges.length)continue;const adjacency=new Map();for(const edge of edges){if(!adjacency.has(edge.from))adjacency.set(edge.from,new Set());if(!adjacency.has(edge.to))adjacency.set(edge.to,new Set());adjacency.get(edge.from).add(edge.to);adjacency.get(edge.to).add(edge.from)}const unseen=new Set(adjacency.keys());while(unseen.size){const start=unseen.values().next().value,stack=[start],component=[];unseen.delete(start);while(stack.length){const id=stack.pop();component.push(id);for(const next of adjacency.get(id)||[])if(unseen.delete(next))stack.push(next)}const endpoints=component.filter(id=>adjacency.get(id)?.size===1);if(!endpoints.length&&!component.some(id=>visited.has(id))){missing.push({kind:"closed_loop_without_visit",groupName:group.name,stationId:null,stationName:"未选择任何到访车站",endpoints:[]});continue}for(const stationId of endpoints)if(!visited.has(stationId))missing.push({kind:"endpoint_not_visited",groupName:group.name,stationId,stationName:stationNames.get(stationId)||stationId,endpoints:endpoints.map(id=>stationNames.get(id)||id)})}}
 return missing;
}
export function validateBeforeExport(file,network){
 const imported=validateImport(file,network),errors=[...imported.errors,...imported.ignored.map(message=>`导出数据包含${message}`)],warnings=[],isolated=isolatedVisits(file,network),missingEndpoints=missingContinuousEndpoints(file,network);
 if(missingEndpoints.length)warnings.push({code:"continuous_endpoint_not_visited",message:`${missingEndpoints.length} 个连续区间端点未标记到访`,items:missingEndpoints});
 if(isolated.length)warnings.push({code:"isolated_station_visit",message:`${isolated.length} 个到访车站不邻接任何已乘区间`,items:isolated});
 return{valid:errors.length===0,errors,warnings,clean:imported.clean};
}
export function downloadBlob(blob,name){const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
