public void fetchResult(String requestId, String statusUrl, boolean isImageFlow, ApiCallback<VideoCreateResponse> cb) {
    Call<JsonObject> call;
    if (statusUrl != null && !statusUrl.isEmpty()) {
        call = raw.getResultByStatusUrl(statusUrl);
    } else {
        call = raw.getResultById(requestId, isImageFlow ? "image" : "text");
    }

    call.enqueue(new Callback<JsonObject>() {
        @Override public void onResponse(@NonNull Call<JsonObject> call, @NonNull Response<JsonObject> resp) {
            if (!resp.isSuccessful() || resp.body() == null) {
                cb.onError(new Exception(buildHttpErrorMessage(resp)));
                return;
            }
            JsonObject b = resp.body();
            if (b.has("error") && !b.get("error").isJsonNull()) {
                cb.onError(new Exception("Server error: " + b.get("error").getAsString()));
                return;
            }
            String status = b.has("status") && !b.get("status").isJsonNull() ? b.get("status").getAsString() : "";
            String url = (b.has("video_url") && !b.get("video_url").isJsonNull()) ? b.get("video_url").getAsString() : "";

            VideoCreateResponse out = new VideoCreateResponse();
            out.setStatus(status);
            out.setVideoUrl(url);
            cb.onSuccess(out);
        }
        @Override public void onFailure(@NonNull Call<JsonObject> call, @NonNull Throwable t) {
            cb.onError(t);
        }
    });
}
