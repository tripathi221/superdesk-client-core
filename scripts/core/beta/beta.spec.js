describe('beta service', function() {
    beforeEach(window.module('superdesk.core.services.beta'));

    it('can filter out sd-beta from html when beta is off',
    inject(function(betaService, $rootScope, $http, $httpBackend) {
        $rootScope.beta = false;
        var isBeta = null;
        betaService.isBeta().then(function(_beta) {
            isBeta = _beta;
        });

        $rootScope.$digest();
        expect(isBeta).toBe(false);

        var template = '<div>normal</div><div sd-beta>beta</div>',
            data;

        $httpBackend.expectGET('view_off.html').respond(200, template);

        $http.get('view_off.html').then(function(response) {
            data = response.data;
        });

        $httpBackend.flush();

        expect(data).not.toContain('beta');
    }));

    it('keeps it there when beta is on',
    inject(function(betaService, preferencesService, $rootScope, $http, $httpBackend, $q) {
        $rootScope.beta = true;

        spyOn(preferencesService, 'get').and.returnValue($q.when({enabled: true}));

        betaService.isBeta().then(function(_beta) {
            expect(_beta).toBe(true);
        });

        $rootScope.$digest();

        var template = '<div sd-beta>beta</div>',
            data;

        $httpBackend.expectGET('view_on.html').respond(200, template);

        $http.get('view_on.html').then(function(response) {
            data = response.data;
        });

        $httpBackend.flush();

        expect(data).toContain('beta');
    }));
});
