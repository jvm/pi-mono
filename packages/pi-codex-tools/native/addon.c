// Native POSIX *at bindings for descriptor-relative filesystem walks.
// Used by apply_patch on platforms without /proc/self/fd (macOS) to keep the
// same TOCTOU-safe, no-follow directory walk that Linux gets via procfs.
#include <node_api.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#include <stdlib.h>
#include <errno.h>
#include <string.h>

static napi_value throw_errno(napi_env env, int err) {
  const char *code = NULL;
  switch (err) {
    case ENOENT: code = "ENOENT"; break;
    case EEXIST: code = "EEXIST"; break;
    case ELOOP: code = "ELOOP"; break;
    case ENOTDIR: code = "ENOTDIR"; break;
    case EACCES: code = "EACCES"; break;
    case EISDIR: code = "EISDIR"; break;
    case ENAMETOOLONG: code = "ENAMETOOLONG"; break;
    case EINVAL: code = "EINVAL"; break;
  }
  napi_value msg, errv;
  if (napi_create_string_utf8(env, strerror(err), NAPI_AUTO_LENGTH, &msg) != napi_ok ||
      napi_create_error(env, NULL, msg, &errv) != napi_ok) {
    napi_throw_error(env, NULL, strerror(err));
    return NULL;
  }
  if (code) {
    napi_value codev;
    napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &codev);
    napi_set_named_property(env, errv, "code", codev);
  }
  napi_value enov;
  napi_create_int32(env, err, &enov);
  napi_set_named_property(env, errv, "errno", enov);
  napi_throw(env, errv);
  return NULL;
}

static char *get_string(napi_env env, napi_value v) {
  size_t len = 0;
  if (napi_get_value_string_utf8(env, v, NULL, 0, &len) != napi_ok) return NULL;
  char *buf = (char *)malloc(len + 1);
  if (!buf) return NULL;
  size_t written = 0;
  if (napi_get_value_string_utf8(env, v, buf, len + 1, &written) != napi_ok) { free(buf); return NULL; }
  return buf;
}

static napi_value OpenAt(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value args[4];
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc < 3) {
    napi_throw_type_error(env, NULL, "openat(dirfd, path, flags[, mode]) requires (dirfd, path, flags)");
    return NULL;
  }
  int dirfd = 0, flags = 0, mode = 0;
  if (napi_get_value_int32(env, args[0], &dirfd) != napi_ok ||
      napi_get_value_int32(env, args[2], &flags) != napi_ok) {
    napi_throw_type_error(env, NULL, "dirfd and flags must be integers");
    return NULL;
  }
  char *path = get_string(env, args[1]);
  if (!path) { napi_throw_type_error(env, NULL, "path must be a string"); return NULL; }
  if (argc >= 4 && napi_get_value_int32(env, args[3], &mode) != napi_ok) {
    free(path); napi_throw_type_error(env, NULL, "mode must be an integer"); return NULL;
  }
  int fd = openat(dirfd, path, flags, (mode_t)mode);
  int saved_errno = errno;
  free(path);
  if (fd < 0) return throw_errno(env, saved_errno);
  napi_value result;
  napi_create_int32(env, fd, &result);
  return result;
}

static napi_value MkdirAt(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc < 2) {
    napi_throw_type_error(env, NULL, "mkdirat(dirfd, path[, mode]) requires (dirfd, path)");
    return NULL;
  }
  int dirfd = 0, mode = 0777;
  if (napi_get_value_int32(env, args[0], &dirfd) != napi_ok) { napi_throw_type_error(env, NULL, "dirfd must be an integer"); return NULL; }
  char *path = get_string(env, args[1]);
  if (!path) { napi_throw_type_error(env, NULL, "path must be a string"); return NULL; }
  if (argc >= 3 && napi_get_value_int32(env, args[2], &mode) != napi_ok) { free(path); napi_throw_type_error(env, NULL, "mode must be an integer"); return NULL; }
  int rc = mkdirat(dirfd, path, (mode_t)mode);
  int saved_errno = errno;
  free(path);
  if (rc < 0) return throw_errno(env, saved_errno);
  napi_value undef;
  napi_get_undefined(env, &undef);
  return undef;
}

static napi_value UnlinkAt(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc < 2) {
    napi_throw_type_error(env, NULL, "unlinkat(dirfd, path) requires (dirfd, path)");
    return NULL;
  }
  int dirfd = 0;
  if (napi_get_value_int32(env, args[0], &dirfd) != napi_ok) { napi_throw_type_error(env, NULL, "dirfd must be an integer"); return NULL; }
  char *path = get_string(env, args[1]);
  if (!path) { napi_throw_type_error(env, NULL, "path must be a string"); return NULL; }
  int rc = unlinkat(dirfd, path, 0);
  int saved_errno = errno;
  free(path);
  if (rc < 0) return throw_errno(env, saved_errno);
  napi_value undef;
  napi_get_undefined(env, &undef);
  return undef;
}

static napi_value LstatAt(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc < 2) {
    napi_throw_type_error(env, NULL, "lstatAt(dirfd, path) requires (dirfd, path)");
    return NULL;
  }
  int dirfd = 0;
  if (napi_get_value_int32(env, args[0], &dirfd) != napi_ok) {
    napi_throw_type_error(env, NULL, "dirfd must be an integer");
    return NULL;
  }
  char *path = get_string(env, args[1]);
  if (!path) {
    napi_throw_type_error(env, NULL, "path must be a string");
    return NULL;
  }
  struct stat st;
  int rc = fstatat(dirfd, path, &st, AT_SYMLINK_NOFOLLOW);
  int saved_errno = errno;
  free(path);
  if (rc < 0) return throw_errno(env, saved_errno);
  napi_value obj, v;
  napi_create_object(env, &obj);
  napi_get_boolean(env, S_ISREG(st.st_mode), &v); napi_set_named_property(env, obj, "isFile", v);
  napi_get_boolean(env, S_ISDIR(st.st_mode), &v); napi_set_named_property(env, obj, "isDirectory", v);
  napi_get_boolean(env, S_ISLNK(st.st_mode), &v); napi_set_named_property(env, obj, "isSymbolicLink", v);
  return obj;
}

static napi_value Init(napi_env env, napi_value exports) {
  const napi_property_descriptor props[] = {
    { "openat", NULL, OpenAt, NULL, NULL, NULL, napi_default, NULL },
    { "mkdirat", NULL, MkdirAt, NULL, NULL, NULL, napi_default, NULL },
    { "unlinkat", NULL, UnlinkAt, NULL, NULL, NULL, napi_default, NULL },
    { "lstatAt", NULL, LstatAt, NULL, NULL, NULL, napi_default, NULL },
  };
  napi_define_properties(env, exports, 4, props);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
