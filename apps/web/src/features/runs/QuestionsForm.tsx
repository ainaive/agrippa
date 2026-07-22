import type { Question } from "@agrippa/core";
import { WandSparklesIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

export type Answers = Record<string, string | boolean>;

/**
 * Form for an `input` checkpoint, rendered from the agent's question
 * snapshot. Every question can be filled from the agent's recommended
 * answer with one click; required questions gate the submit.
 */
export function QuestionsForm({
  questions,
  disabled,
  onSubmit,
}: {
  questions: Question[];
  disabled: boolean;
  onSubmit: (answers: Answers) => void;
}) {
  const { t } = useTranslation("runs");
  const [answers, setAnswers] = useState<Answers>({});

  const setAnswer = (id: string, value: string | boolean): void =>
    setAnswers((prev) => ({ ...prev, [id]: value }));

  const missing = questions.filter(
    (q) => q.required !== false && (answers[q.id] === undefined || answers[q.id] === ""),
  );
  const recommendable = questions.filter((q) => q.recommended !== undefined);

  return (
    <div className="space-y-4">
      {questions.map((question, index) => (
        <div key={question.id} className="space-y-1.5">
          <Label className="gap-1">
            <span className="text-muted-foreground tabular-nums">{index + 1}.</span>
            {question.text}
            {question.required !== false ? <span className="text-destructive">*</span> : null}
          </Label>
          {question.kind === "boolean" ? (
            <Switch
              checked={answers[question.id] === true}
              disabled={disabled}
              onCheckedChange={(checked) => setAnswer(question.id, checked)}
            />
          ) : question.kind === "select" ? (
            <Select
              value={
                typeof answers[question.id] === "string" ? (answers[question.id] as string) : ""
              }
              disabled={disabled}
              onValueChange={(value) => setAnswer(question.id, value)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(question.options ?? []).map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Textarea
              rows={2}
              value={
                typeof answers[question.id] === "string" ? (answers[question.id] as string) : ""
              }
              disabled={disabled}
              onChange={(e) => setAnswer(question.id, e.target.value)}
            />
          )}
          {question.recommended !== undefined && answers[question.id] === undefined ? (
            <button
              type="button"
              className="flex items-center gap-1 text-xs text-primary hover:underline"
              disabled={disabled}
              onClick={() => setAnswer(question.id, question.recommended as string)}
            >
              <WandSparklesIcon className="size-3" />
              {t("checkpoint.useRecommendation", { value: question.recommended })}
            </button>
          ) : null}
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={disabled || missing.length > 0}
          onClick={() => onSubmit(answers)}
        >
          {t("checkpoint.submitAnswers")}
        </Button>
        {recommendable.length > 0 ? (
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => {
              const filled: Answers = { ...answers };
              for (const q of recommendable)
                filled[q.id] = filled[q.id] ?? (q.recommended as string);
              onSubmit(filled);
            }}
          >
            <WandSparklesIcon />
            {t("checkpoint.acceptAllRecommendations")}
          </Button>
        ) : null}
      </div>
      {missing.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("checkpoint.answersMissing", { count: missing.length })}
        </p>
      ) : null}
    </div>
  );
}
