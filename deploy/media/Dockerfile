ARG LITELLM_BASE_IMAGE=docker.litellm.ai/berriai/litellm:main-stable
FROM ${LITELLM_BASE_IMAGE}

USER root
COPY --chmod=0555 deploy/media/entrypoint.sh /app/chatbot-media-entrypoint.sh
COPY --chmod=0444 config/media-litellm.yaml /app/chatbot-media-config.yaml

ENTRYPOINT ["/app/chatbot-media-entrypoint.sh"]
CMD ["--config", "/app/chatbot-media-config.yaml"]
