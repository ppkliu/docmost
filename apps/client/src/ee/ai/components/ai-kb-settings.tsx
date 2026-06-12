import { useState } from "react";
import {
  Badge,
  Button,
  Group,
  Modal,
  PasswordInput,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconCheck,
  IconDatabase,
  IconPlugConnected,
  IconX,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deleteKbConnector,
  getKbConnectors,
  testKbConnector,
  upsertKbConnector,
} from "@/ee/ai/services/ai-kb-service.ts";
import { useHasFeature } from "@/ee/hooks/use-feature";
import { Feature } from "@/ee/features";
import {
  KbConnector,
  KbTestResponse,
  KbType,
} from "@/ee/ai/types/ai.types.ts";

const KB_TYPES = [
  { value: "cognee", label: "Cognee" },
  { value: "llm-wiki", label: "LLM-Wiki" },
  { value: "custom", label: "Custom" },
];

function ConnectorFormModal({
  opened,
  onClose,
  connector,
}: {
  opened: boolean;
  onClose: () => void;
  connector?: KbConnector | null;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const isEditing = !!connector;

  const [type, setType] = useState<string | null>(connector?.type || "cognee");
  const [name, setName] = useState(connector?.name || "");
  const [baseUrl, setBaseUrl] = useState(connector?.baseUrl || "");
  const [apiKey, setApiKey] = useState("");
  const [searchPath, setSearchPath] = useState(connector?.searchPath || "");
  const [testResult, setTestResult] = useState<KbTestResponse | null>(null);

  const saveMutation = useMutation({
    mutationFn: upsertKbConnector,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ai-kb"] });
      notifications.show({ message: t("Knowledge base saved") });
      onClose();
    },
    onError: (err: any) => {
      notifications.show({
        message: err?.response?.data?.message || t("Failed to save"),
        color: "red",
      });
    },
  });

  const testMutation = useMutation({
    mutationFn: testKbConnector,
    onSuccess: setTestResult,
    onError: (err: any) => {
      setTestResult(null);
      notifications.show({
        message: err?.response?.data?.message || t("Connection test failed"),
        color: "red",
      });
    },
  });

  const handleTest = () => {
    setTestResult(null);
    testMutation.mutate({
      id: connector?.id,
      type: type || undefined,
      baseUrl: baseUrl.trim() || undefined,
      apiKey: apiKey || undefined,
      searchPath: searchPath.trim() || undefined,
    });
  };

  const handleSave = () => {
    saveMutation.mutate({
      id: connector?.id,
      type: (type || "custom") as KbType,
      name: name.trim(),
      baseUrl: baseUrl.trim(),
      apiKey: apiKey || undefined,
      searchPath: searchPath.trim() || undefined,
    });
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={isEditing ? t("Edit knowledge base") : t("Add knowledge base")}
    >
      <Stack gap="sm">
        <Select
          label={t("Type")}
          data={KB_TYPES}
          value={type}
          onChange={setType}
          allowDeselect={false}
        />
        <TextInput
          label={t("Name")}
          placeholder="Team Cognee"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
        />
        <TextInput
          label={t("Base URL")}
          placeholder="http://cognee.internal:8000"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.currentTarget.value)}
        />
        <PasswordInput
          label={t("API key")}
          placeholder={
            connector?.hasApiKey ? t("•••• (saved — leave blank to keep)") : ""
          }
          value={apiKey}
          onChange={(e) => setApiKey(e.currentTarget.value)}
        />
        {type === "custom" && (
          <TextInput
            label={t("Search path")}
            placeholder="/search"
            description={t("POST endpoint receiving { query, limit }")}
            value={searchPath}
            onChange={(e) => setSearchPath(e.currentTarget.value)}
          />
        )}

        {testResult && (
          <Group gap="xs" wrap="nowrap">
            {testResult.success ? (
              <IconCheck size={16} color="var(--mantine-color-green-6)" />
            ) : (
              <IconX size={16} color="var(--mantine-color-red-6)" />
            )}
            <Text size="sm" c={testResult.success ? "dimmed" : "red"}>
              {testResult.message}
              {testResult.latencyMs > 0 && ` (${testResult.latencyMs}ms)`}
            </Text>
          </Group>
        )}

        <Group justify="flex-end">
          <Button
            variant="default"
            leftSection={<IconPlugConnected size={16} />}
            onClick={handleTest}
            loading={testMutation.isPending}
            disabled={!baseUrl.trim() && !connector}
          >
            {t("Test connection")}
          </Button>
          <Button
            onClick={handleSave}
            loading={saveMutation.isPending}
            disabled={!name.trim() || !baseUrl.trim()}
          >
            {t("Save")}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export default function AiKbSettings() {
  const { t } = useTranslation();
  const hasAccess = useHasFeature(Feature.AI);
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<KbConnector | null>(null);

  const { data } = useQuery({ queryKey: ["ai-kb"], queryFn: getKbConnectors });
  const connectors = data?.connectors ?? [];

  const upsertMutation = useMutation({
    mutationFn: upsertKbConnector,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["ai-kb"] }),
  });
  const deleteMutation = useMutation({
    mutationFn: deleteKbConnector,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["ai-kb"] }),
  });

  const toggleEnabled = (kb: KbConnector, enabled: boolean) => {
    upsertMutation.mutate({
      id: kb.id,
      type: kb.type,
      name: kb.name,
      baseUrl: kb.baseUrl,
      searchPath: kb.searchPath,
      enabled,
    });
  };

  return (
    <Stack gap="sm">
      <Group justify="space-between">
        <div>
          <Text size="md" fw={500}>
            {t("External knowledge bases")}
          </Text>
          <Text size="sm" c="dimmed">
            {t(
              "Connect Cognee, LLM-Wiki, or custom search servers. AI Chat gains a search tool per enabled connector.",
            )}
          </Text>
        </div>
        <Button
          variant="default"
          size="xs"
          leftSection={<IconDatabase size={14} />}
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
          disabled={!hasAccess}
        >
          {t("Add knowledge base")}
        </Button>
      </Group>

      {connectors.map((kb) => (
        <Group key={kb.id} justify="space-between" wrap="nowrap">
          <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
            <Text size="sm" fw={500} truncate>
              {kb.name}
            </Text>
            <Badge size="xs" variant="light">
              {kb.type}
            </Badge>
            {kb.hasApiKey && (
              <Badge size="xs" variant="outline">
                {t("key")}
              </Badge>
            )}
            <Text size="xs" c="dimmed" truncate>
              {kb.baseUrl}
            </Text>
          </Group>
          <Group gap="xs" wrap="nowrap">
            <Switch
              size="xs"
              checked={kb.enabled}
              onChange={(e) => toggleEnabled(kb, e.currentTarget.checked)}
              disabled={!hasAccess}
              aria-label={t("Toggle connector")}
            />
            <Button
              variant="subtle"
              size="compact-xs"
              onClick={() => {
                setEditing(kb);
                setFormOpen(true);
              }}
            >
              {t("Edit")}
            </Button>
            <Button
              variant="subtle"
              size="compact-xs"
              color="red"
              onClick={() => deleteMutation.mutate(kb.id)}
            >
              {t("Delete")}
            </Button>
          </Group>
        </Group>
      ))}

      {connectors.length === 0 && (
        <Text size="sm" c="dimmed">
          {t("No knowledge bases connected yet.")}
        </Text>
      )}

      {formOpen && (
        <ConnectorFormModal
          opened={formOpen}
          onClose={() => setFormOpen(false)}
          connector={editing}
        />
      )}
    </Stack>
  );
}
