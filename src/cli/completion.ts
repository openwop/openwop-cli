import type { Ctx } from '../context.js';
/** `openwop completion <shell>` — emit a static shell-completion script for the
 *  top-level commands (generated from the dispatcher's command+alias table, so it
 *  never drifts). Per-subcommand completion is out of scope; top-level covers the 80%. */
import { CliError } from '../errors.js';
import { write } from '../io.js';

export const COMPLETION_HELP = `Usage:
  openwop completion <bash|zsh|fish>

Emit a shell-completion script for openwop's top-level commands. Install it:
  bash:  openwop completion bash > \${BASH_COMPLETION_USER_DIR:-~/.local/share/bash-completion}/completions/openwop
  zsh:   openwop completion zsh  > "\${fpath[1]}/_openwop"   # then: autoload -U compinit && compinit
  fish:  openwop completion fish > ~/.config/fish/completions/openwop.fish
`;

function bashScript(cmds: string): string {
  return `# openwop bash completion — source this or drop it in your bash-completion dir.
_openwop() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "\${COMP_CWORD}" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${cmds}" -- "\${cur}") )
    return 0
  fi
}
complete -F _openwop openwop
`;
}

function zshScript(cmds: string): string {
  return `#compdef openwop
# openwop zsh completion — install as _openwop on your fpath.
_openwop() {
  local -a _cmds
  _cmds=(${cmds})
  _arguments '1: :(\${_cmds})' '*::arg:->args'
}
_openwop "$@"
`;
}

function fishScript(commands: string[]): string {
  const lines = commands.map((c) => `complete -c openwop -n __fish_use_subcommand -a ${c}`);
  return `# openwop fish completion — install as ~/.config/fish/completions/openwop.fish
${lines.join('\n')}
`;
}

export function runCompletion(ctx: Ctx, argv: string[], commands: string[]): number {
  const shell = argv[0];
  if (shell === '--help' || shell === '-h') {
    write(ctx.io.stdout, COMPLETION_HELP);
    return 0;
  }
  if (!shell) {
    write(ctx.io.stderr, COMPLETION_HELP);
    return 2;
  }
  const cmds = commands.join(' ');
  switch (shell) {
    case 'bash':
      write(ctx.io.stdout, bashScript(cmds));
      return 0;
    case 'zsh':
      write(ctx.io.stdout, zshScript(cmds));
      return 0;
    case 'fish':
      write(ctx.io.stdout, fishScript(commands));
      return 0;
    default:
      throw new CliError(`Unsupported shell: ${shell}. Use one of: bash | zsh | fish.`, 2);
  }
}
