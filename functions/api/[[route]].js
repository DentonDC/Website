import { handleApi } from "../../src/api.js";

export async function onRequest(context) {
  return handleApi(context.request, context.env);
}
