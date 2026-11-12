/**
 * A problem with a signing request, worded for the editor who made it. The
 * server answers with these messages as they are, and with a fixed one for any
 * other error, whose message could name the server's own files or code.
 */
export class SignError extends Error {
  override name = "SignError";
}
