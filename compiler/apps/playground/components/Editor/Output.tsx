/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  CodeIcon,
  DocumentAddIcon,
  InformationCircleIcon,
} from '@heroicons/react/outline';
import MonacoEditor, {DiffEditor} from '@monaco-editor/react';
import {
  CompilerErrorDetail,
  CompilerDiagnostic,
  type CompilerError,
} from 'babel-plugin-react-compiler';
import parserBabel from 'prettier/plugins/babel';
import * as prettierPluginEstree from 'prettier/plugins/estree';
import * as prettier from 'prettier/standalone';
import {memo, ReactNode, useEffect, useState} from 'react';
import {type Store} from '../../lib/stores';
import TabbedWindow from '../TabbedWindow';
import {monacoOptions} from './monacoOptions';
import {BabelFileResult} from '@babel/core';
const MemoizedOutput = memo(Output);

export default MemoizedOutput;

export type PrintedCompilerPipelineValue =
  | {
      kind: 'hir';
      name: string;
      fnName: string | null;
      value: string;
    }
  | {kind: 'reactive'; name: string; fnName: string | null; value: string}
  | {kind: 'debug'; name: string; fnName: string | null; value: string};

export type CompilerTransformOutput = {
  code: string;
  sourceMaps: BabelFileResult['map'];
  language: 'flow' | 'typescript';
};
export type CompilerOutput =
  | {
      kind: 'ok';
      transformOutput: CompilerTransformOutput;
      results: Map<string, Array<PrintedCompilerPipelineValue>>;
      errors: Array<CompilerErrorDetail | CompilerDiagnostic>;
    }
  | {
      kind: 'err';
      results: Map<string, Array<PrintedCompilerPipelineValue>>;
      error: CompilerError;
    };

type Props = {
  store: Store;
  compilerOutput: CompilerOutput;
};

async function tabify(
  source: string,
  compilerOutput: CompilerOutput,
): Promise<Map<string, ReactNode>> {
  const tabs = new Map<string, React.ReactNode>();
  const reorderedTabs = new Map<string, React.ReactNode>();
  const concattedResults = new Map<string, string>();
  // Concat all top level function declaration results into a single tab for each pass
  for (const [passName, results] of compilerOutput.results) {
    for (const result of results) {
      switch (result.kind) {
        case 'hir': {
          const prev = concattedResults.get(result.name);
          const next = result.value;
          const identName = `function ${result.fnName}`;
          if (prev != null) {
            concattedResults.set(passName, `${prev}\n\n${identName}\n${next}`);
          } else {
            concattedResults.set(passName, `${identName}\n${next}`);
          }
          break;
        }
        case 'reactive': {
          const prev = concattedResults.get(passName);
          const next = result.value;
          if (prev != null) {
            concattedResults.set(passName, `${prev}\n\n${next}`);
          } else {
            concattedResults.set(passName, next);
          }
          break;
        }
        case 'debug': {
          concattedResults.set(passName, result.value);
          break;
        }
        default: {
          const _: never = result;
          throw new Error('Unexpected result kind');
        }
      }
    }
  }
  let lastPassOutput: string | null = null;
  let nonDiffPasses = ['HIR', 'BuildReactiveFunction', 'EnvironmentConfig'];
  for (const [passName, text] of concattedResults) {
    tabs.set(
      passName,
      <TextTabContent
        output={text}
        diff={lastPassOutput}
        showInfoPanel={!nonDiffPasses.includes(passName)}></TextTabContent>,
    );
    lastPassOutput = text;
  }
  // Ensure that JS and the JS source map come first
  if (compilerOutput.kind === 'ok') {
    const {transformOutput} = compilerOutput;
    const sourceMapUrl = getSourceMapUrl(
      transformOutput.code,
      JSON.stringify(transformOutput.sourceMaps),
    );
    const code = await prettier.format(transformOutput.code, {
      semi: true,
      parser: transformOutput.language === 'flow' ? 'babel-flow' : 'babel-ts',
      plugins: [parserBabel, prettierPluginEstree],
    });

    let output: string;
    let language: string;
    if (compilerOutput.errors.length === 0) {
      output = code;
      language = 'javascript';
    } else {
      language = 'markdown';
      output = `
# Summary

React Compiler compiled this function successfully, but there are lint errors that indicate potential issues with the original code.

## ${compilerOutput.errors.length} Lint Errors

${compilerOutput.errors.map(e => e.printErrorMessage(source, {eslint: false})).join('\n\n')}

## Output

\`\`\`js
${code}
\`\`\`
`.trim();
    }

    reorderedTabs.set(
      'Output',
      <TextTabContent
        output={output}
        language={language}
        diff={null}
        showInfoPanel={false}></TextTabContent>,
    );
    if (sourceMapUrl) {
      reorderedTabs.set(
        'SourceMap',
        <>
          <iframe
            src={sourceMapUrl}
            className="w-full h-monaco_small sm:h-monaco"
            title="Generated Code"
          />
        </>,
      );
    }
  } else if (compilerOutput.kind === 'err') {
    const errors = compilerOutput.error.printErrorMessage(source, {
      eslint: false,
    });
    reorderedTabs.set(
      'Output',
      <TextTabContent
        output={errors}
        language="markdown"
        diff={null}
        showInfoPanel={false}></TextTabContent>,
    );
  }
  tabs.forEach((tab, name) => {
    reorderedTabs.set(name, tab);
  });
  return reorderedTabs;
}

function utf16ToUTF8(s: string): string {
  return unescape(encodeURIComponent(s));
}

function getSourceMapUrl(code: string, map: string): string | null {
  code = utf16ToUTF8(code);
  map = utf16ToUTF8(map);
  return `https://evanw.github.io/source-map-visualization/#${btoa(
    `${code.length}\0${code}${map.length}\0${map}`,
  )}`;
}

function Output({store, compilerOutput}: Props): JSX.Element {
  const [tabsOpen, setTabsOpen] = useState<Set<string>>(
    () => new Set(['Output']),
  );
  const [tabs, setTabs] = useState<Map<string, React.ReactNode>>(
    () => new Map(),
  );

  /*
   * Update the active tab back to the output or errors tab when the compilation state
   * changes between success/failure.
   */
  const [previousOutputKind, setPreviousOutputKind] = useState(
    compilerOutput.kind,
  );
  if (compilerOutput.kind !== previousOutputKind) {
    setPreviousOutputKind(compilerOutput.kind);
    setTabsOpen(new Set(['Output']));
  }

  useEffect(() => {
    tabify(store.source, compilerOutput).then(tabs => {
      setTabs(tabs);
    });
  }, [store.source, compilerOutput]);

  const changedPasses: Set<string> = new Set(['Output', 'HIR']); // Initial and final passes should always be bold
  let lastResult: string = '';
  for (const [passName, results] of compilerOutput.results) {
    for (const result of results) {
      let currResult = '';
      if (result.kind === 'hir' || result.kind === 'reactive') {
        currResult += `function ${result.fnName}\n\n${result.value}`;
      }
      if (currResult !== lastResult) {
        changedPasses.add(passName);
      }
      lastResult = currResult;
    }
  }

  return (
    <>
      <TabbedWindow
        defaultTab="HIR"
        setTabsOpen={setTabsOpen}
        tabsOpen={tabsOpen}
        tabs={tabs}
        changedPasses={changedPasses}
      />
    </>
  );
}

function TextTabContent({
  output,
  diff,
  showInfoPanel,
  language,
}: {
  output: string;
  diff: string | null;
  showInfoPanel: boolean;
  language: string;
}): JSX.Element {
  const [diffMode, setDiffMode] = useState(false);
  return (
    /**
     * Restrict MonacoEditor's height, since the config autoLayout:true
     * will grow the editor to fit within parent element
     */
    <div className="w-full h-monaco_small sm:h-monaco">
      {showInfoPanel ? (
        <div className="flex items-center gap-1 bg-amber-50 p-2">
          {diff != null && output !== diff ? (
            <button
              className="flex items-center gap-1 transition-colors duration-150 ease-in text-secondary hover:text-link"
              onClick={() => setDiffMode(diffMode => !diffMode)}>
              {!diffMode ? (
                <>
                  <DocumentAddIcon className="w-5 h-5" /> Show Diff
                </>
              ) : (
                <>
                  <CodeIcon className="w-5 h-5" /> Show Output
                </>
              )}
            </button>
          ) : (
            <>
              <span className="flex items-center gap-1">
                <InformationCircleIcon className="w-5 h-5" /> No changes from
                previous pass
              </span>
            </>
          )}
        </div>
      ) : null}
      {diff != null && diffMode ? (
        <DiffEditor
          original={diff}
          modified={output}
          options={{
            ...monacoOptions,
            readOnly: true,
            lineNumbers: 'off',
            glyphMargin: false,
            // Undocumented see https://github.com/Microsoft/vscode/issues/30795#issuecomment-410998882
            lineDecorationsWidth: 0,
            lineNumbersMinChars: 0,
          }}
        />
      ) : (
        <MonacoEditor
          language={language ?? 'javascript'}
          value={output}
          options={{
            ...monacoOptions,
            readOnly: true,
            lineNumbers: 'off',
            glyphMargin: false,
            // Undocumented see https://github.com/Microsoft/vscode/issues/30795#issuecomment-410998882
            lineDecorationsWidth: 0,
            lineNumbersMinChars: 0,
          }}
        />
      )}
    </div>
  );
}
