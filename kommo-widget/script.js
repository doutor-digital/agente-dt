/**
 * Widget "Agente DT" para o Salesbot do Kommo (modo widget_request).
 *
 * Adiciona um passo "Widget" no designer do Salesbot. Quando o bot chega nesse
 * passo, dispara um `widget_request` (POST) pro nosso backend
 * (/api/webhooks/<slug>/widget) com a mensagem do paciente + o lead, e o bot
 * fica PAUSADO. O backend roda a IA e RETOMA o bot via `return_url` com
 * `execute_handlers` [show…, goto finish]
 * (ver backend/src/controllers/widget.controller.ts).
 *
 * Único parâmetro: a URL do webhook (params.url), preenchida no designer.
 */
define(['jquery'], function ($) {
  var CustomWidget = function () {
    var self = this;

    this.callbacks = {
      settings: function () {},
      init: function () {
        return true;
      },
      bind_actions: function () {
        return true;
      },
      render: function () {
        return true;
      },
      dpSettings: function () {},
      onSave: function () {
        return true;
      },
      destroy: function () {},

      /**
       * Chamado ao salvar o passo Widget no designer. Retorna (como STRING JSON)
       * os blocos que o bot executa:
       *   1) widget_request → manda { message, lead } pro backend e pausa o bot.
       *   2) goto question step 1 → fallback (normalmente terminamos o bot pelo
       *      `goto finish` dentro do continue, antes de chegar aqui).
       *   3) conditions em {{json.status}} → success/fail (devolvemos
       *      data:{status:'success'} no continue).
       */
      onSalesbotDesignerSave: function (handler_code, params) {
        var url = params && params.url ? params.url : '';

        // `{{message_text}}` = texto da última mensagem do paciente;
        // `{{lead.id}}` = id do lead. Se a mensagem chegar vazia no backend,
        // ajuste o placeholder conforme sua conta (algumas usam {{message.text}}).
        var request_data = {
          message: '{{message_text}}',
          lead: '{{lead.id}}'
        };

        return JSON.stringify([
          {
            question: [
              {
                handler: 'widget_request',
                params: {
                  url: url,
                  data: request_data
                }
              },
              {
                handler: 'goto',
                params: {
                  type: 'question',
                  step: 1
                }
              }
            ]
          },
          {
            question: [
              {
                handler: 'conditions',
                params: {
                  logic: 'and',
                  conditions: [
                    {
                      term1: '{{json.status}}',
                      term2: 'success',
                      operation: '='
                    }
                  ],
                  result: [
                    {
                      handler: 'exits',
                      params: { value: 'success' }
                    }
                  ]
                }
              },
              {
                handler: 'exits',
                params: { value: 'fail' }
              }
            ]
          }
        ]);
      },

      /** Saídas do bloco no designer (success/fail), pra quem quiser encadear. */
      salesbotDesignerSettings: function () {
        return {
          exits: [
            { code: 'success', title: 'Resposta enviada' },
            { code: 'fail', title: 'Falha ao responder' }
          ]
        };
      }
    };

    return this;
  };

  return CustomWidget;
});
