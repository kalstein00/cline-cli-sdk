import {Ajv2020,type ValidateFunction} from "ajv/dist/2020.js";
import {SdkError} from "./reducer.js";

export type JsonSchema=boolean|{[keyword:string]:unknown};
export function schemaValidator(schema:JsonSchema):{schema:JsonSchema;validate:ValidateFunction} {
  let nodes=0;
  const active=new WeakSet<object>();
  const bounded=(value:unknown,depth:number)=>{
    if(++nodes>2048 || depth>32) throw new SdkError("invalid-schema","Schema is limited to 2048 values and depth 32.");
    if(value===null || typeof value==="string" || typeof value==="boolean" || (typeof value==="number" && Number.isFinite(value))) return;
    if(typeof value!=="object" || active.has(value) || (!Array.isArray(value) && ![Object.prototype,null].includes(Object.getPrototypeOf(value)))) throw new SdkError("invalid-schema","Schema must contain only finite JSON values without cycles.");
    active.add(value);for(const child of Object.values(value)) bounded(child,depth+1);active.delete(value);
  };
  bounded(schema,0);
  if(typeof schema!=="boolean" && (!schema || Array.isArray(schema))) throw new SdkError("invalid-schema","Schema must be an object or boolean.");
  const encoded=JSON.stringify(schema);
  if(Buffer.byteLength(encoded)>65536) throw new SdkError("invalid-schema","Schema exceeds 64 KiB.");
  const copy=JSON.parse(encoded) as JsonSchema;
  const resolve=(ref:string):unknown=>{
    if(ref!=="#" && !ref.startsWith("#/")) throw new SdkError("unsupported-schema","Only local JSON pointer references are supported.");
    let node:unknown=copy;
    for(const raw of ref==="#"?[]:ref.slice(2).split("/")) {
      const key=raw.replace(/~1/g,"/").replace(/~0/g,"~");
      if(!node || typeof node!=="object" || !Object.hasOwn(node,key)) throw new SdkError("invalid-schema","Unresolved local schema reference.");
      node=(node as Record<string,unknown>)[key];
    }
    return node;
  };
  let expanded=0;
  const visit=(value:unknown,refs:Set<string>,depth:number)=>{
    if(depth>32) throw new SdkError("unsupported-schema","Schema reference depth exceeds 32.");
    if(!value || typeof value!=="object" || Array.isArray(value)) return;
    if(++expanded>8192) throw new SdkError("unsupported-schema","Expanded schema traversal exceeds 8192 nodes.");
    const node=value as Record<string,unknown>;
    if(node.$schema!==undefined && node.$schema!=="https://json-schema.org/draft/2020-12/schema") throw new SdkError("unsupported-schema","Only JSON Schema draft 2020-12 is supported.");
    for(const keyword of ["$id","$async","$dynamicRef","$recursiveRef","pattern","patternProperties"]) if(Object.hasOwn(node,keyword)) throw new SdkError("unsupported-schema",`Unsupported schema keyword: ${keyword}`);
    if(typeof node.$ref==="string") {
      if(refs.has(node.$ref)) throw new SdkError("unsupported-schema","Recursive schema references are not supported.");
      visit(resolve(node.$ref),new Set([...refs,node.$ref]),depth+1);
    }
    for(const keyword of ["properties","$defs","dependentSchemas"]) {
      const children=node[keyword];if(children && typeof children==="object") for(const child of Object.values(children)) visit(child,refs,depth+1);
    }
    for(const keyword of ["items","additionalProperties","unevaluatedProperties","unevaluatedItems","contains","not","if","then","else","propertyNames"]) visit(node[keyword],refs,depth+1);
    for(const keyword of ["prefixItems","allOf","anyOf","oneOf"]) if(Array.isArray(node[keyword])) for(const child of node[keyword]) visit(child,refs,depth+1);
  };
  visit(copy,new Set(),0);
  try {
    const ajv=new Ajv2020({strict:true,allErrors:true,coerceTypes:false,useDefaults:false,removeAdditional:false,inlineRefs:false});
    return {schema:copy,validate:ajv.compile(copy)};
  } catch(error) {throw new SdkError("invalid-schema",String(error).slice(0,500));}
}
